import { A2AClient } from '../../client/client.js';
import {
    Task,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatusUpdateEvent,
    Message
} from '../../schema.js';
import crypto from 'node:crypto';
import { AgentRegistry, ManagedAgent } from './agent_registry.js';
import { ConversationMemory } from './conversation_memory.js';
import { TaskPlan, TaskRouter } from './task_router.js';

// Define a custom error type for input-required situations
class InputRequiredError extends Error {
    agents: string[];
    inputRequiredAgents: Map<string, { subTaskId: string }>;

    constructor(message: string, agents: string[], inputRequiredAgents: Map<string, { subTaskId: string }>) {
        super(message);
        this.name = 'InputRequiredError';
        this.agents = agents;
        this.inputRequiredAgents = inputRequiredAgents;
    }
}

// Initialize shared services as singletons
const agentRegistry = new AgentRegistry();
const conversationMemory = new ConversationMemory();
const taskRouter = new TaskRouter();

/**
 * Initialize the orchestrator - setup agent registry and make initial connections
 */
async function initializeOrchestrator(): Promise<void> {
    // Initialize with default agents
    await agentRegistry.initializeDefaults();
}

/**
 * Generate a task ID for a sub-task based on the parent task ID and agent
 */
function generateSubTaskId(parentTaskId: string, agentName: string): string {
    return `${parentTaskId}-${agentName.toLowerCase().replace(/\s+/g, '-')}`;
}

/**
 * Generate a unique conversation ID
 */
function generateConversationId(): string {
    return `conv-${crypto.randomUUID()}`;
}

/**
 * Process a user request and determine a plan for execution
 */
async function planExecution(
    taskId: string,
    userMessage: Message,
    sessionId?: string
): Promise<{ plan: TaskPlan, conversation: string }> {
    // Get or create conversation for this session
    let conversationId = sessionId || generateConversationId();
    let conversation = conversationMemory.getConversation(conversationId);

    if (!conversation) {
        conversation = conversationMemory.createConversation(conversationId);
    }

    // Add the user message to the conversation
    conversationMemory.addUserMessage(conversationId, userMessage, taskId);

    // Check if there's an agent waiting for input from a previous interaction
    const lastInputRequiredState = conversation.lastState;

    // Get conversation summary for context
    const conversationSummary = conversationMemory.getConversationSummary(conversationId);

    // Get all active agents
    const activeAgents = agentRegistry.getAllAgents()
        .filter(agent => agent.status === 'active');

    if (activeAgents.length === 0) {
        throw new Error("No active agents available");
    }

    // Analyze request and create task plan - passing also the lastInputRequiredState
    const plan = await taskRouter.analyzeRequest(
        userMessage,
        activeAgents,
        conversationSummary,
        lastInputRequiredState
    );

    return { plan, conversation: conversationId };
}

/**
 * Execute a task plan against specialized agents
 */
async function* executeTaskPlan(
    taskId: string,
    conversationId: string,
    taskPlan: TaskPlan
): AsyncGenerator<{
    agentName: string;
    event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
}> {
    const agentsByName = new Map<string, ManagedAgent>();
    const selectedAgents: ManagedAgent[] = [];
    const inputRequiredAgents = new Map<string, { subTaskId: string }>();

    // Get all the selected agents from the registry
    for (const agentName of taskPlan.selectedAgents) {
        const agent = agentRegistry.findAgentByName(agentName);
        if (agent) {
            agentsByName.set(agentName, agent);
            selectedAgents.push(agent);
        } else {
            console.warn(`Selected agent not found: ${agentName}`);
        }
    }

    if (selectedAgents.length === 0) {
        throw new Error("None of the selected agents are available");
    }

    // Get conversation summary for context
    const conversationSummary = conversationMemory.getConversationSummary(conversationId);

    // Get the latest user message from the conversation
    const conversation = conversationMemory.getConversation(conversationId);
    if (!conversation || conversation.turns.length === 0) {
        throw new Error("No conversation found or conversation has no turns");
    }

    const latestUserMessage = conversation.turns[conversation.turns.length - 1].userMessage;

    // Prepare sub-task streams
    const streamingTasks: Array<{
        agentName: string;
        stream: AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>;
    }> = [];

    // Check if we're continuing a conversation with an agent that was waiting for input
    const isResumingInputRequiredTask = taskPlan.metadata?.waitingSubTaskId;

    // Start each agent's task with specialized prompts or continue existing tasks
    for (const [agentName, agent] of agentsByName.entries()) {
        try {
            let stream: AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>;
            let subTaskId: string;

            if (isResumingInputRequiredTask && taskPlan.metadata?.waitingSubTaskId) {
                // We're continuing a conversation with an agent that was waiting for input
                // Use the existing subTaskId from the metadata rather than generating a new one
                subTaskId = taskPlan.metadata.waitingSubTaskId as string;
                console.log(`Continuing existing task for ${agentName} with ID: ${subTaskId}`);

                // Send the direct user response to the agent without special prompt generation
                stream = agent.client.sendTaskSubscribe({
                    id: subTaskId,
                    sessionId: conversationId,
                    message: latestUserMessage // Send the original user message directly without modification
                });
            } else {
                // Generate a new sub-task ID for normal flow
                subTaskId = generateSubTaskId(taskId, agentName);

                // Generate specialized prompt for this agent
                const subTaskPrompt = await taskRouter.generateSubTaskPrompt(
                    taskPlan.taskDescription,
                    agentName,
                    agent.card.description || '',
                    taskPlan,
                    conversationSummary
                );

                // Create task message with proper typing
                const taskMessage = {
                    role: 'user' as const,
                    parts: [{ text: subTaskPrompt }]
                };

                // Start a new streaming task for this agent
                console.log(`Starting new sub-task for ${agentName} with ID: ${subTaskId}`);
                stream = agent.client.sendTaskSubscribe({
                    id: subTaskId,
                    sessionId: conversationId, // Use conversation ID as session for context
                    message: taskMessage
                });
            }

            streamingTasks.push({ agentName, stream });

            // Record sub-task in conversation memory
            conversationMemory.addSubTaskInfo(conversationId, agentName, subTaskId, true);
        } catch (error) {
            console.error(`Error handling task for ${agentName}:`, error);
            // In case of error, still track the subTaskId for reference
            const subTaskId = isResumingInputRequiredTask && taskPlan.metadata?.waitingSubTaskId
                ? taskPlan.metadata.waitingSubTaskId as string
                : generateSubTaskId(taskId, agentName);
            conversationMemory.addSubTaskInfo(conversationId, agentName, subTaskId, false);
        }
    }

    // Stream multiplexing logic - unchanged
    const activeStreams = new Map(streamingTasks.map(task => [task.agentName, {
        done: false,
        iterator: task.stream[Symbol.asyncIterator]()
    }]));

    while (activeStreams.size > 0) {
        const streamPromises: Array<Promise<{
            agentName: string,
            event?: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
            done: boolean
        }>> = [];

        // Create a promise for the next value from each active stream
        for (const [agentName, streamState] of activeStreams.entries()) {
            streamPromises.push(
                streamState.iterator.next().then(result => ({
                    agentName,
                    event: result.value,
                    done: result.done
                }))
                    .catch(err => {
                        console.error(`Error reading from stream for ${agentName}:`, err);
                        return { agentName, done: true };
                    })
            );
        }

        // Wait for the first stream to produce a value
        if (streamPromises.length === 0) break;

        const { agentName, event, done } = await Promise.race(streamPromises);

        if (done) {
            // This stream is finished
            activeStreams.delete(agentName);
            continue;
        }

        if (event) {
            // Check if this is an input-required status update
            if (
                "status" in event &&
                event.status.state === "input-required"
            ) {
                const agent = agentsByName.get(agentName);
                if (agent) {
                    // Store the agent as waiting for input
                    const subTaskId = isResumingInputRequiredTask && taskPlan.metadata?.waitingSubTaskId && agentName === taskPlan.selectedAgents[0]
                        ? taskPlan.metadata.waitingSubTaskId as string  // Use existing subTaskId if continuing a conversation
                        : generateSubTaskId(taskId, agentName);         // Otherwise generate a new one

                    inputRequiredAgents.set(agentName, {
                        subTaskId
                    });

                    // Record in conversation memory that this agent is waiting for input
                    conversationMemory.setInputRequiredState(conversationId, agentName, subTaskId);

                    // Yield the event so the client knows input is required
                    yield { agentName, event };

                    // Mark stream as done for now - it will be reactivated when user provides input
                    activeStreams.delete(agentName);
                    continue;
                }
            }

            // Yield this event with its source agent
            yield { agentName, event };
        }
    }

    // If any agents are waiting for input, no need to throw an error anymore
    // Just return without throwing since we've already yielded the input-required events
    if (inputRequiredAgents.size > 0) {
        // Just log it instead of throwing an error
        console.log(`Waiting for user input for agents: ${Array.from(inputRequiredAgents.keys()).join(', ')}`);
        return;
    }
}

/**
 * Process final agent responses and integrate them
 */
async function integrateAgentResponses(
    taskId: string,
    conversationId: string,
    taskPlan: TaskPlan,
    results: Map<string, Task | null>
): Promise<string> {
    // Format agent responses for integration
    const agentResponses = [];

    for (const [agentName, result] of results.entries()) {
        if (!result) {
            console.warn(`No result for agent ${agentName}`);
            continue;
        }

        // Extract response text from the task result
        let responseText = '';

        if (result.status?.message?.parts) {
            responseText = result.status.message.parts
                .filter(part => 'text' in part)
                .map(part => ('text' in part) ? part.text : '')
                .join('\n');
        }

        // Also include any artifact content
        if (result.artifacts && result.artifacts.length > 0) {
            for (const artifact of result.artifacts) {
                const artifactText = artifact.parts
                    .filter(part => 'text' in part)
                    .map(part => ('text' in part) ? part.text : '')
                    .join('\n');

                if (artifactText.trim()) {
                    responseText += `\n\n${artifactText}`;
                }
            }
        }

        if (responseText.trim()) {
            agentResponses.push({
                agentName,
                response: responseText
            });
        }
    }

    // If no responses, provide a better error message with more debugging info
    if (agentResponses.length === 0) {
        console.error(`No responses collected for task ${taskId}. TaskPlan:`, JSON.stringify(taskPlan, null, 2));
        console.error(`Results map has ${results.size} entries, with keys: ${[...results.keys()].join(', ')}`);

        // Check if it was an input-required situation that failed
        if (taskPlan.metadata?.waitingSubTaskId) {
            return "I wasn't able to process your response. Please try asking your question again from the beginning.";
        }

        return "I couldn't determine which specialized agents to use for this task. Please try a different request or check that agents are available.";
    }

    // For single-agent tasks with a single response, we might not need integration
    if (!taskPlan.isMultiAgentTask && agentResponses.length === 1) {
        return agentResponses[0].response;
    }

    // Integrate multiple responses
    return await taskRouter.integrateResponses(
        taskPlan.taskDescription,
        agentResponses,
        taskPlan
    );
}

// Export the orchestration functions
export {
    initializeOrchestrator,
    planExecution,
    executeTaskPlan,
    integrateAgentResponses,
    agentRegistry,
    conversationMemory
};