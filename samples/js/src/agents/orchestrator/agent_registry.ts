import { A2AClient } from '../../client/client.js';
import { AgentCard } from '../../schema.js';

// Represents an agent managed by the orchestrator
export interface ManagedAgent {
    id: string;           // Unique identifier for the agent
    name: string;         // Human-readable name
    url: string;          // Base URL for the agent
    card: AgentCard;      // The agent's card with capabilities
    client: A2AClient;    // Client for communicating with the agent
    capabilities?: string[]; // Derived capabilities (keywords/topics)
    status: 'active' | 'unreachable'; // Current availability status
    lastChecked: Date;    // When agent availability was last checked
}

export class AgentRegistry {
    private agents: Map<string, ManagedAgent> = new Map();
    private agentsByCapability: Map<string, Set<string>> = new Map();

    constructor() { }

    /**
     * Add or update an agent in the registry
     */
    async addAgent(url: string): Promise<ManagedAgent | null> {
        try {
            const client = new A2AClient(url);
            const card = await client.agentCard();

            // Extract an ID from the URL
            const id = this.generateAgentId(url);

            // Extract capabilities from the agent card
            const capabilities = this.extractCapabilities(card);

            const agent: ManagedAgent = {
                id,
                name: card.name,
                url,
                card,
                client,
                capabilities,
                status: 'active',
                lastChecked: new Date()
            };

            // Store the agent
            this.agents.set(id, agent);

            // Index by capabilities
            if (capabilities) {
                capabilities.forEach(capability => {
                    if (!this.agentsByCapability.has(capability)) {
                        this.agentsByCapability.set(capability, new Set());
                    }
                    this.agentsByCapability.get(capability)?.add(id);
                });
            }

            console.log(`Added agent: ${agent.name} (${url})`);
            return agent;
        } catch (error) {
            console.error(`Failed to add agent at ${url}:`, error);
            return null;
        }
    }

    /**
     * Generate a unique ID for an agent based on its URL
     */
    private generateAgentId(url: string): string {
        return `agent-${url.replace(/[^\w]/g, '-')}`;
    }

    /**
     * Extract capabilities keywords from an agent card
     */
    private extractCapabilities(card: AgentCard): string[] {
        const capabilities: Set<string> = new Set();

        // Extract from skills
        card.skills.forEach(skill => {
            // Add the skill ID and name as capabilities
            capabilities.add(skill.id.toLowerCase());
            capabilities.add(skill.name.toLowerCase());

            // Add all tags
            skill.tags?.forEach(tag => capabilities.add(tag.toLowerCase()));

            // Extract keywords from description
            if (skill.description) {
                const keywords = this.extractKeywords(skill.description);
                keywords.forEach(kw => capabilities.add(kw.toLowerCase()));
            }
        });

        // Extract from agent description
        if (card.description) {
            const keywords = this.extractKeywords(card.description);
            keywords.forEach(kw => capabilities.add(kw.toLowerCase()));
        }

        return Array.from(capabilities);
    }

    /**
     * Simple keyword extraction from text
     */
    private extractKeywords(text: string): string[] {
        // Remove common words and extract potential keywords
        const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'in', 'to', 'that', 'it', 'with', 'as', 'for', 'on', 'by']);
        return text
            .toLowerCase()
            .split(/\W+/)
            .filter(word => word.length > 3 && !stopWords.has(word));
    }

    /**
     * Get all registered agents
     */
    getAllAgents(): ManagedAgent[] {
        return Array.from(this.agents.values());
    }

    /**
     * Get active agents that match specific capabilities
     */
    findAgentsByCapabilities(capabilities: string[]): ManagedAgent[] {
        // Get all agent IDs that match any of the capabilities
        const matchingAgentIds = new Set<string>();

        capabilities.forEach(capability => {
            const lowerCapability = capability.toLowerCase();
            this.agentsByCapability.forEach((agentIds, indexedCapability) => {
                if (indexedCapability.includes(lowerCapability)) {
                    agentIds.forEach(id => matchingAgentIds.add(id));
                }
            });
        });

        // Convert IDs to agents and filter for active ones
        return Array.from(matchingAgentIds)
            .map(id => this.agents.get(id))
            .filter(agent => agent && agent.status === 'active') as ManagedAgent[];
    }

    /**
     * Find an agent by name (case-insensitive partial match)
     */
    findAgentByName(name: string): ManagedAgent | undefined {
        const lowerName = name.toLowerCase();
        return Array.from(this.agents.values()).find(
            agent => agent.name.toLowerCase().includes(lowerName)
        );
    }

    /**
     * Get an agent by its ID
     */
    getAgent(id: string): ManagedAgent | undefined {
        return this.agents.get(id);
    }

    /**
     * Check if all agents are reachable and update their status
     */
    async checkAgentsHealth(): Promise<void> {
        const checks = [];

        for (const [id, agent] of this.agents.entries()) {
            checks.push(
                (async () => {
                    try {
                        await agent.client.agentCard();
                        agent.status = 'active';
                    } catch (error) {
                        console.warn(`Agent ${agent.name} is unreachable:`, error);
                        agent.status = 'unreachable';
                    }
                    agent.lastChecked = new Date();
                })()
            );
        }

        await Promise.all(checks);
    }

    /**
     * Initialize the registry with default agents
     */
    async initializeDefaults(): Promise<void> {
        // Add the standard agents we know about
        const defaultAgents = [
            'http://localhost:41242', // Coder agent
            'http://localhost:41243'  // Movie agent
        ];

        await Promise.all(defaultAgents.map(url => this.addAgent(url)));
    }
}