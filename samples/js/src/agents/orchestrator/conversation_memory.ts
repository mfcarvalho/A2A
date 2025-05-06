import { Message, Task } from '../../schema.js';

// Types for conversation history
export interface ConversationTurn {
    userMessage: Message;
    agentResponse?: Message;
    timestamp: Date;
    taskId?: string;
    subTasks?: {
        agentName: string;
        taskId: string;
        success: boolean;
    }[];
}

// Track information about agents waiting for input
export interface InputRequiredState {
    inputRequiredAgent: string;
    subTaskId: string;
    requestTimestamp: Date;
}

export interface Conversation {
    id: string;
    startedAt: Date;
    lastUpdatedAt: Date;
    turns: ConversationTurn[];
    metadata: Record<string, unknown>;
    lastState?: InputRequiredState; // Track the last input-required state
}

// Stores conversation history for the orchestrator
export class ConversationMemory {
    private conversations: Map<string, Conversation> = new Map();

    /**
     * Create a new conversation
     */
    createConversation(id: string, metadata: Record<string, unknown> = {}): Conversation {
        const now = new Date();
        const conversation: Conversation = {
            id,
            startedAt: now,
            lastUpdatedAt: now,
            turns: [],
            metadata
        };

        this.conversations.set(id, conversation);
        return conversation;
    }

    /**
     * Get a conversation by ID
     */
    getConversation(id: string): Conversation | undefined {
        return this.conversations.get(id);
    }

    /**
     * Add a new turn to a conversation
     */
    addUserMessage(conversationId: string, userMessage: Message, taskId?: string): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation with ID ${conversationId} not found`);
        }

        const turn: ConversationTurn = {
            userMessage,
            timestamp: new Date(),
            taskId
        };

        conversation.turns.push(turn);
        conversation.lastUpdatedAt = turn.timestamp;
    }

    /**
     * Add agent response to the last turn in a conversation
     */
    addAgentResponse(conversationId: string, agentResponse: Message): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation || conversation.turns.length === 0) {
            throw new Error(`Conversation with ID ${conversationId} not found or has no turns`);
        }

        const lastTurn = conversation.turns[conversation.turns.length - 1];
        lastTurn.agentResponse = agentResponse;
        conversation.lastUpdatedAt = new Date();
    }

    /**
     * Track that an agent is waiting for user input
     */
    setInputRequiredState(conversationId: string, agentName: string, subTaskId: string): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            throw new Error(`Conversation with ID ${conversationId} not found`);
        }

        conversation.lastState = {
            inputRequiredAgent: agentName,
            subTaskId,
            requestTimestamp: new Date()
        };
        conversation.lastUpdatedAt = new Date();

        console.log(`Set input-required state for ${agentName} with subTaskId ${subTaskId}`);
    }

    /**
     * Clear the input-required state when it's no longer needed
     */
    clearInputRequiredState(conversationId: string): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation) {
            return; // Silently ignore if conversation not found
        }

        if (conversation.lastState) {
            console.log(`Cleared input-required state for ${conversation.lastState.inputRequiredAgent}`);
            delete conversation.lastState;
        }
    }

    /**
     * Add sub-task information to the latest turn
     */
    addSubTaskInfo(conversationId: string, agentName: string, taskId: string, success: boolean): void {
        const conversation = this.conversations.get(conversationId);
        if (!conversation || conversation.turns.length === 0) {
            throw new Error(`Conversation with ID ${conversationId} not found or has no turns`);
        }

        const lastTurn = conversation.turns[conversation.turns.length - 1];
        if (!lastTurn.subTasks) {
            lastTurn.subTasks = [];
        }

        lastTurn.subTasks.push({
            agentName,
            taskId,
            success
        });
    }

    /**
     * Get conversation summary for LLM context
     * Returns a string summarizing the conversation history
     */
    getConversationSummary(conversationId: string, maxTurns: number = 5): string {
        const conversation = this.conversations.get(conversationId);
        if (!conversation || conversation.turns.length === 0) {
            return "No conversation history.";
        }

        // Get the most recent turns, limited by maxTurns
        const recentTurns = conversation.turns.slice(-maxTurns);

        // Format the turns for inclusion in a prompt
        return recentTurns.map((turn, index) => {
            const userText = turn.userMessage.parts
                .filter(part => 'text' in part)
                .map(part => ('text' in part) ? part.text : '')
                .join('\n');

            const agentText = turn.agentResponse?.parts
                .filter(part => 'text' in part)
                .map(part => ('text' in part) ? part.text : '')
                .join('\n') || "No response";

            return `Turn ${index + 1}:
                    User: ${userText}
                    Agent: ${agentText}`;
        }).join('\n\n');
    }

    /**
     * Get all conversations
     */
    getAllConversations(): Conversation[] {
        return Array.from(this.conversations.values());
    }

    /**
     * Delete a conversation
     */
    deleteConversation(id: string): boolean {
        return this.conversations.delete(id);
    }
}