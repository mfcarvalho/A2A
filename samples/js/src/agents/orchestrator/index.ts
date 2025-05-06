import { TaskHandler, TaskYieldUpdate } from '../../server/handler.js';
import { A2AServer } from '../../server/server.js';
import * as schema from '../../schema.js';
import {
    initializeOrchestrator,
    planExecution,
    executeTaskPlan,
    integrateAgentResponses,
    agentRegistry,
    conversationMemory
} from './orchestrator.js';

// Ensure required API key is available
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
}

// Create an agent card that describes the orchestrator's capabilities
const agentCard: schema.AgentCard = {
    name: "Host Agent Orchestrator",
    description: "An intelligent orchestrator that coordinates multiple specialized agents to solve complex tasks. Works like the host agent in the A2A demo.",
    version: "1.0.0",
    url: "http://localhost:41241",
    capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: true
    },
    skills: [
        {
            id: "multi_agent_orchestration",
            name: "Multi-Agent Orchestration",
            description: "Coordinates multiple specialized agents to fulfill complex tasks requiring diverse capabilities",
            tags: ["orchestration", "coordination", "multi-agent", "delegation"],
            examples: [
                "Create a React component with movie information and an image",
                "Generate code to display data from Spider-Man movies",
                "Combine movie information with code generation",
                "Add a new agent to the registry",
                "Answer questions using the most appropriate specialized agent"
            ]
        },
        {
            id: "agent_registry_management",
            name: "Agent Registry Management",
            description: "Manages the registry of available agents that can handle tasks",
            tags: ["management", "registry", "agents"],
            examples: [
                "Add a new agent at http://localhost:8000",
                "List all available agents",
                "Check if the movie agent is available"
            ]
        },
        {
            id: "conversation_memory",
            name: "Conversation Memory",
            description: "Maintains context and history across multiple conversation turns",
            tags: ["memory", "context", "conversation"],
            examples: [
                "Remember what we discussed earlier",
                "Use information from previous responses"
            ]
        }
    ],
    provider: {
        organization: "A2A Samples"
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
};

// Main handler for incoming tasks
const handler: TaskHandler = async function* (
    context
): AsyncGenerator<TaskYieldUpdate, schema.Task | void, unknown> {
    const { task, userMessage } = context;
    const taskId = task.id;
    const sessionId = task.sessionId; // Use session ID for conversation tracking

    // Extract user text from the message for various checks
    const userText = userMessage.parts
        .filter(part => 'text' in part)
        .map(part => ('text' in part) ? part.text : '')
        .join('\n')
        .toLowerCase();

    // Check if this is a response to a previous input-required state
    // by examining the previous task status stored in conversation memory
    const conversation = conversationMemory.getConversation(sessionId || '');
    const previousState = conversation?.lastState;

    // If this is a response to an input-required state, we need to route it to the correct agent
    if (previousState?.inputRequiredAgent) {
        const agentName = previousState.inputRequiredAgent;
        const subTaskId = previousState.subTaskId;

        yield {
            state: "working",
            message: {
                role: "agent",
                parts: [{ text: `Sending your response to ${agentName}...` }]
            }
        };

        try {
            // Find the agent that was waiting for input
            const agent = agentRegistry.findAgentByName(agentName);
            if (!agent) {
                throw new Error(`Agent ${agentName} not found`);
            }

            // Forward the user message to the specific agent's subtask
            const stream = agent.client.sendTaskSubscribe({
                id: subTaskId,
                sessionId: sessionId || undefined,
                message: userMessage
            });

            // Process responses from the agent
            for await (const event of stream) {
                // Yield the event with agent attribution
                yield {
                    state: "working",
                    message: {
                        role: "agent",
                        parts: [{
                            text: `[${agentName}]: ${'status' in event && event.status.message ?
                                event.status.message.parts
                                    .filter(part => 'text' in part)
                                    .map(part => ('text' in part) ? part.text : '')
                                    .join('\n') :
                                'No message'
                                }`
                        }]
                    }
                };

                // Check if this is a final state
                if ('status' in event &&
                    ['completed', 'failed', 'canceled'].includes(event.status.state)) {
                    // Clear the input-required state
                    conversationMemory.clearInputRequiredState(sessionId || '');

                    // Return with a completion status
                    yield {
                        state: "completed",
                        message: {
                            role: "agent",
                            parts: [{
                                text: `${agentName} has completed processing your input.`
                            }]
                        }
                    };
                    return;
                }

                // If the agent still needs input, maintain that state
                if ('status' in event && event.status.state === 'input-required') {
                    // Update the conversation memory with the continuing input-required state
                    conversationMemory.setInputRequiredState(sessionId || '', agentName, subTaskId);

                    // Get the input request message
                    const message = event.status.message?.parts
                        .filter(part => 'text' in part)
                        .map(part => ('text' in part) ? part.text : '')
                        .join('\n') || "The agent needs more information";

                    // Forward the input-required status
                    yield {
                        state: "input-required",
                        message: {
                            role: "agent",
                            parts: [{
                                text: `${agentName} needs additional information: ${message}`
                            }]
                        }
                    };
                    return;
                }
            }

            // If we reach here, the stream ended without a conclusive state
            conversationMemory.clearInputRequiredState(sessionId || '');
            yield {
                state: "completed",
                message: {
                    role: "agent",
                    parts: [{ text: `Finished processing your response to ${agentName}.` }]
                }
            };
            return;
        } catch (error) {
            console.error(`Error forwarding input to ${agentName}:`, error);
            yield {
                state: "failed",
                message: {
                    role: "agent",
                    parts: [{
                        text: `Failed to forward your response to ${agentName}: ${error instanceof Error ? error.message : String(error)
                            }`
                    }]
                }
            };
            return;
        }
    }

    // Yield initial status update
    yield {
        state: "working",
        message: {
            role: "agent",
            parts: [{ text: "I'm analyzing your request and coordinating with the appropriate agents..." }]
        }
    };

    try {
        // Handle special commands for agent management
        if (userText.includes('add agent') || userText.includes('register agent')) {
            // Extract URL from text using regex
            const urlMatch = userText.match(/https?:\/\/[^\s]+/);
            if (urlMatch) {
                const agentUrl = urlMatch[0];

                yield {
                    state: "working",
                    message: {
                        role: "agent",
                        parts: [{ text: `Attempting to add agent at ${agentUrl}...` }]
                    }
                };

                const agent = await agentRegistry.addAgent(agentUrl);

                if (agent) {
                    yield {
                        state: "completed",
                        message: {
                            role: "agent",
                            parts: [{ text: `Successfully added ${agent.name} at ${agentUrl} to the registry.` }]
                        }
                    };
                } else {
                    yield {
                        state: "failed",
                        message: {
                            role: "agent",
                            parts: [{ text: `Failed to add agent at ${agentUrl}. The agent may be unreachable or not A2A-compliant.` }]
                        }
                    };
                }
                return;
            }
        } else if (userText.includes('list agents') || userText === 'agents') {
            const agents = agentRegistry.getAllAgents();

            if (agents.length === 0) {
                yield {
                    state: "completed",
                    message: {
                        role: "agent",
                        parts: [{ text: "No agents are currently registered." }]
                    }
                };
                return;
            }

            const agentList = agents.map(a =>
                `- ${a.name} (${a.url}) - Status: ${a.status}\n  ${a.card.description || 'No description'}`
            ).join('\n\n');

            yield {
                state: "completed",
                message: {
                    role: "agent",
                    parts: [{ text: `Registered agents:\n\n${agentList}` }]
                }
            };
            return;
        } else if (userText.includes('check agents') || userText.includes('health check')) {
            yield {
                state: "working",
                message: {
                    role: "agent",
                    parts: [{ text: "Checking health status of all agents..." }]
                }
            };

            await agentRegistry.checkAgentsHealth();
            const agents = agentRegistry.getAllAgents();
            const activeCount = agents.filter(a => a.status === 'active').length;

            yield {
                state: "completed",
                message: {
                    role: "agent",
                    parts: [{ text: `Health check complete. ${activeCount} out of ${agents.length} agents are active.` }]
                }
            };
            return;
        }

        // Plan execution for the task
        yield {
            state: "working",
            message: {
                role: "agent",
                parts: [{ text: "Planning the best approach to your request..." }]
            }
        };

        const { plan, conversation } = await planExecution(taskId, userMessage, sessionId);

        if (plan.selectedAgents.length === 0) {
            yield {
                state: "failed",
                message: {
                    role: "agent",
                    parts: [{
                        text: "I couldn't determine which --error-- specialized agents to use for this task. Please try a different request or check that agents are available."
                    }]
                }
            };
            return;
        }

        // Report on the execution plan
        yield {
            state: "working",
            message: {
                role: "agent",
                parts: [{
                    text: `I'll ${plan.isMultiAgentTask ? 'coordinate multiple agents' : 'use a specialized agent'} to address your request. Selected: ${plan.selectedAgents.join(', ')}`
                }]
            }
        };

        // Execute the plan and process streaming responses
        const results = new Map<string, schema.Task | null>();

        try {
            // Process the streaming results from agents
            const streamGenerator = executeTaskPlan(taskId, conversation, plan);

            // Keep track of agents that need input
            let waitingForInput = false;
            let inputRequiredMessage = "";
            let agentNeedingInput = "";

            for await (const { agentName, event } of streamGenerator) {
                // Track completed results for final integration
                if ('status' in event &&
                    ['completed', 'failed', 'canceled'].includes(event.status.state)) {

                    try {
                        // Find the agent in our registry
                        const agent = agentRegistry.findAgentByName(agentName);
                        if (agent) {
                            const subTaskId = `${taskId}-${agentName.toLowerCase().replace(/\s+/g, '-')}`;
                            const fullTask = await agent.client.getTask({ id: subTaskId });
                            if (fullTask) {
                                results.set(agentName, fullTask);
                            }
                        }
                    } catch (error) {
                        console.error(`Error retrieving full task for ${agentName}:`, error);
                    }
                }

                // Check for input-required state
                if ('status' in event && event.status.state === 'input-required') {
                    waitingForInput = true;
                    agentNeedingInput = agentName;

                    // Extract the input request message
                    if (event.status.message) {
                        inputRequiredMessage = event.status.message.parts
                            .filter(part => 'text' in part)
                            .map(part => ('text' in part) ? part.text : '')
                            .join('\n');
                    }
                }

                // Forward interesting status updates to the user with agent attribution
                if ('status' in event && event.status.message) {
                    const eventText = event.status.message.parts
                        .filter(part => 'text' in part)
                        .map(part => ('text' in part) ? part.text : '')
                        .join('\n');

                    if (eventText.trim()) {
                        yield {
                            state: "working",
                            message: {
                                role: "agent",
                                parts: [{
                                    text: `[${agentName}]: ${eventText.length > 100 ?
                                        eventText.substring(0, 100) + '...' :
                                        eventText}`
                                }]
                            }
                        };
                    }
                }

                // Forward artifacts with attribution
                if ('artifact' in event) {
                    // Create a copy of the artifact for our response
                    yield {
                        name: `${agentName} - ${event.artifact.name || 'Unnamed artifact'}`,
                        parts: event.artifact.parts,
                        index: event.artifact.index,
                        lastChunk: event.artifact.lastChunk,
                        metadata: {
                            ...(event.artifact.metadata || {}),
                            sourceAgent: agentName
                        }
                    };
                }

                // Check for cancellation
                if (context.isCancelled()) {
                    yield {
                        state: "canceled",
                        message: {
                            role: "agent",
                            parts: [{ text: "Task has been canceled." }]
                        }
                    };
                    return;
                }
            }

            // If any agent needs input, forward the input-required state to the user
            if (waitingForInput && agentNeedingInput) {
                yield {
                    state: "input-required",
                    message: {
                        role: "agent",
                        parts: [{
                            text: `${agentNeedingInput} needs additional information: ${inputRequiredMessage || "Please provide the requested information."}`
                        }]
                    }
                };
                return; // End the task handler here, waiting for user input
            }

            // Compose the final response from agent results
            yield {
                state: "working",
                message: {
                    role: "agent",
                    parts: [{ text: "Integrating responses from specialized agents..." }]
                }
            };

            const composedResponse = await integrateAgentResponses(
                taskId,
                conversation,
                plan,
                results
            );

            // Create the final response message
            const responseMessage = {
                role: "agent" as const,
                parts: [{ text: composedResponse }]
            };

            // Store the response in conversation memory
            conversationMemory.addAgentResponse(conversation, responseMessage);

            // Send the final composed response
            yield {
                state: "completed",
                message: responseMessage
            };

        } catch (error) {
            console.error('Error during task execution:', error);
            yield {
                state: "failed",
                message: {
                    role: "agent",
                    parts: [{
                        text: `I encountered an error coordinating the agents: ${error instanceof Error ? error.message : String(error)}`
                    }]
                }
            };
        }

    } catch (error) {
        console.error('Orchestrator error:', error);
        yield {
            state: "failed",
            message: {
                role: "agent",
                parts: [{
                    text: `I encountered an error: ${error instanceof Error ? error.message : String(error)}`
                }]
            }
        };
    }
};

// Initialize orchestrator
(async () => {
    try {
        await initializeOrchestrator();
        console.log("Orchestrator initialized successfully");
    } catch (error) {
        console.error("Orchestrator initialization failed:", error);
        process.exit(1);
    }
})();

// Set up and start the server
const orchestratorPort = parseInt(process.env.ORCHESTRATOR_PORT || '41241');
const server = new A2AServer(handler, {
    card: agentCard,
    basePath: '/',
});

server.start(orchestratorPort);
console.log(`Host Agent Orchestrator started on port ${orchestratorPort}`);
console.log(`You can now interact with it using the CLI: npm run a2a:cli http://localhost:${orchestratorPort}`);