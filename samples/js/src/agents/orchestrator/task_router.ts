import { ManagedAgent } from './agent_registry.js';
import { ai } from './genkit.js';
import { Message } from '../../schema.js';
import { InputRequiredState } from './conversation_memory.js'; // Importando InputRequiredState

// Interface for task planning
export interface TaskPlan {
    taskDescription: string;
    isMultiAgentTask: boolean;
    selectedAgents: string[];
    subTasks: Map<string, string>;
    executionOrder: 'parallel' | 'sequential';
    needsCoordination: boolean;
    metadata?: Record<string, unknown>; // Optional metadata for additional context
    continueWithAgent?: string; // Adicionado para indicar continuação de conversa com um agente específico
    continuationContext?: string; // Contexto adicional para a continuação
}

// Task router handles analysis and planning for task execution
export class TaskRouter {
    /**
     * Analyze a user message and create a task plan
     */
    async analyzeRequest(
        userMessage: Message,
        availableAgents: ManagedAgent[],
        conversationSummary?: string,
        lastInputRequiredState?: InputRequiredState // Adicionado para passar o estado de continuação
    ): Promise<TaskPlan> {
        // Se houver um estado de "input-required" anterior, priorizar o mesmo agente
        if (lastInputRequiredState) {
            const { inputRequiredAgent, subTaskId } = lastInputRequiredState;

            // Verificar se o agente que solicitou entrada ainda está disponível
            const agentStillAvailable = availableAgents.some(
                agent => agent.name.toLowerCase() === inputRequiredAgent.toLowerCase()
            );

            if (agentStillAvailable) {
                console.log(`Priorizando continuação com ${inputRequiredAgent} que solicitou entrada do usuário`);

                // Criar um plano direto para o agente que estava aguardando entrada
                return {
                    taskDescription: "Continuando conversa com agente que solicitou entrada",
                    isMultiAgentTask: false,
                    selectedAgents: [inputRequiredAgent],
                    subTasks: new Map([[inputRequiredAgent, "Continuando conversa anterior"]]),
                    executionOrder: 'parallel',
                    needsCoordination: false,
                    continueWithAgent: inputRequiredAgent,
                    metadata: {
                        waitingSubTaskId: subTaskId,
                        isAwaitingInputContinuation: true
                    }
                };
            }
        }

        // Extract text from user message
        const userText = userMessage.parts
            .filter(part => 'text' in part)
            .map(part => ('text' in part) ? part.text : '')
            .join('\n');

        // Create descriptions of available agents for the prompt
        const agentDescriptions = availableAgents.map(agent => {
            const skills = agent.card.skills.map(s => s.name).join(", ");
            return `${agent.name}: ${agent.card.description || 'No description'} (Skills: ${skills})`;
        }).join('\n');

        // Create the prompt for task analysis
        let prompt = `
You are a task routing system that analyzes user requests and determines which agent(s) should handle them.

Available agents:
${agentDescriptions}

User request: "${userText}"
`;

        // Add conversation history for context if available
        if (conversationSummary) {
            prompt += `\n\nConversation history:\n${conversationSummary}\n`;

            // Adicionar instrução específica para priorizar continuidade
            prompt += `
Based on this conversation history, determine if the user is continuing a conversation with a specific agent.
If it appears to be a follow-up to a previous response from a specific agent, prioritize routing to that same agent.
`;
        }

        prompt += `
Analyze the request and determine:
1. Which agent(s) should handle this task?
2. Does this require multiple agents working together?
3. What specific sub-tasks should be assigned to each selected agent?
4. Should the agents work in parallel or sequential order?
5. Is this request continuing a conversation with a specific agent? If yes, identify which one.

Respond in JSON format:
{
  "selectedAgents": ["Agent Name 1", "Agent Name 2"], // Names of selected agents
  "isMultiAgentTask": true/false, // Whether multiple agents are needed
  "subTasks": { "Agent Name 1": "specific instructions", "Agent Name 2": "specific instructions" },
  "executionOrder": "parallel" or "sequential", // How agents should execute
  "needsCoordination": true/false, // Whether the host should coordinate between agents
  "continueWithAgent": "Agent Name or null" // If this is continuing a conversation with a specific agent
}
`;

        try {
            const { response } = await ai.generateStream({
                messages: [{ role: "user" as const, content: [{ text: prompt }] }]
            });

            const result = await response;
            const responseText = result.text.trim();

            // Extract the JSON part
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);

            if (jsonMatch) {
                const analysisResult = JSON.parse(jsonMatch[0]);

                // Convert to our TaskPlan interface
                const taskPlan: TaskPlan = {
                    taskDescription: userText,
                    isMultiAgentTask: analysisResult.isMultiAgentTask || false,
                    selectedAgents: analysisResult.selectedAgents || [],
                    subTasks: new Map(
                        Object.entries(analysisResult.subTasks || {})
                    ),
                    executionOrder: analysisResult.executionOrder || 'parallel',
                    needsCoordination: analysisResult.needsCoordination || false,
                    continueWithAgent: analysisResult.continueWithAgent || undefined
                };

                return taskPlan;
            } else {
                throw new Error("Could not parse task analysis result");
            }
        } catch (error) {
            console.error('Error analyzing task:', error);

            // Fallback to simple plan using all available agents
            const fallbackPlan: TaskPlan = {
                taskDescription: userText,
                isMultiAgentTask: availableAgents.length > 1,
                selectedAgents: availableAgents.map(a => a.name),
                subTasks: new Map(
                    availableAgents.map(a => [a.name, userText])
                ),
                executionOrder: 'parallel',
                needsCoordination: availableAgents.length > 1
            };

            return fallbackPlan;
        }
    }

    /**
     * Generate a specialized sub-task prompt for an agent
     */
    async generateSubTaskPrompt(
        originalTask: string,
        agentName: string,
        agentDescription: string,
        taskPlan: TaskPlan,
        conversationSummary?: string
    ): Promise<string> {
        // Get the base sub-task from the plan
        const baseSubTask = taskPlan.subTasks.get(agentName) || originalTask;

        // For simple single-agent tasks, just use the original task
        if (!taskPlan.isMultiAgentTask) {
            return baseSubTask;
        }

        // For multi-agent tasks, create a specialized prompt
        const prompt = `
You are creating a specialized sub-task for ${agentName}, which ${agentDescription}

Original user request: "${originalTask}"

Based on task analysis, ${agentName} should handle: "${baseSubTask}"

${conversationSummary ? `\nRelevant conversation history:\n${conversationSummary}` : ''}

Create a clear, specific instruction for ${agentName} that:
1. Focuses only on the aspects relevant to this agent's capabilities
2. Provides necessary context without overwhelming
3. Is specific and actionable
4. Will produce output that can be combined with other agents' outputs

Return ONLY the final instruction without explanations.
`;

        try {
            const { response } = await ai.generateStream({
                messages: [{ role: "user" as const, content: [{ text: prompt }] }]
            });

            const result = await response;
            return result.text.trim();
        } catch (error) {
            console.error(`Error generating sub-task prompt for ${agentName}:`, error);
            // Fallback to the basic sub-task
            return baseSubTask;
        }
    }

    /**
     * Integrate multiple agent responses into a cohesive response
     */
    async integrateResponses(
        originalTask: string,
        agentResponses: { agentName: string, response: string }[],
        taskPlan: TaskPlan
    ): Promise<string> {
        // For single agent tasks, just return the response directly
        if (!taskPlan.isMultiAgentTask && agentResponses.length === 1) {
            return agentResponses[0].response;
        }

        // Format agent responses for the prompt
        const formattedResponses = agentResponses
            .map(r => `${r.agentName}:\n${r.response}`)
            .join('\n\n' + '-'.repeat(40) + '\n\n');

        const prompt = `
You are an expert orchestrator that composes comprehensive responses from specialized agents.

The original user request was: "${originalTask}"

You have received the following responses from specialized agents:
${formattedResponses}

Create a unified, coherent response that:
1. Integrates information from all agents
2. Resolves any conflicts between agent responses
3. Presents the most complete solution to the user's request
4. Maintains all important technical details
5. Attributes information to each agent only if relevant
6. Is conversational and helpful in tone

Your response:
`;

        try {
            const { response } = await ai.generateStream({
                messages: [{ role: "user" as const, content: [{ text: prompt }] }]
            });

            const result = await response;
            return result.text.trim();
        } catch (error) {
            console.error('Error integrating responses:', error);
            // Fallback - concatenate all responses with attributions
            return agentResponses
                .map(r => `[From ${r.agentName}]:\n${r.response}`)
                .join('\n\n' + '-'.repeat(40) + '\n\n');
        }
    }
}