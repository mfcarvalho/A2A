# Multi-Agent Orchestrator

This orchestrator agent coordinates tasks between multiple specialized agents.

## Features

- Routes tasks to the appropriate specialized agent(s)
- Enables collaboration between the Movie Agent and Coder Agent
- Handles complex tasks requiring multiple capabilities
- Aggregates responses from multiple agents into a cohesive output

## Example Usage

Use this orchestrator when you need to combine capabilities, such as:
- Creating a React component with movie data (using both Coder Agent and Movie Agent)
- Generating code that includes movie information
- Any task requiring both coding and movie knowledge

## How It Works

The orchestrator:
1. Analyzes the user request
2. Determines which specialized agents are needed
3. Distributes sub-tasks to appropriate agents
4. Compiles responses into a unified answer

## Running the Agent

```bash
# Start the orchestrator agent
npm run agents:orchestrator

# In another terminal, connect using the CLI client
npm run a2a:cli
```