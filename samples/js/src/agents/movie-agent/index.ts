import {
  A2AServer,
  TaskContext,
  TaskYieldUpdate,
  schema,
  InMemoryTaskStore, // Assuming default store
} from "../../server/index.js";
import { MessageData } from "genkit";
import { ai } from "./genkit.js";
import { searchMovies, searchPeople } from "./tools.js";

// Load the prompt defined in movie_agent.prompt
const movieAgentPrompt = ai.prompt("movie_agent");

/**
 * Task Handler for the Movie Agent.
 */
async function* movieAgentHandler(
  context: TaskContext
): AsyncGenerator<TaskYieldUpdate> {
  console.log(
    `[MovieAgent] Processing task ${context.task.id} with state ${context.task.status.state}`
  );

  // Log the full context for debugging
  console.log(`[MovieAgent] Context details:
  - Session ID: ${context.task.sessionId ?? 'none'}
  - History length: ${context.history?.length ?? 0} messages
  - History: ${JSON.stringify(context.history, null, 2)}
  - User message: ${JSON.stringify(context.userMessage, null, 2)}
  `);

  // Yield an initial "working" status
  yield {
    state: "working",
    message: {
      role: "agent",
      parts: [{ text: "Processing your question, hang tight!" }],
    },
  };

  // Prepare messages for Genkit prompt using the full history from context
  const messages: MessageData[] = (context.history ?? []) // Use history if available, default to empty array
    .map((m) => ({
      // Map roles explicitly and assert the type for Genkit
      role: (m.role === "agent" ? "model" : "user") as "user" | "model",
      content: m.parts
        .filter((p): p is schema.TextPart => !!(p as schema.TextPart).text) // Filter for text parts
        .map((p) => ({
          text: p.text,
        })),
    }))
    // Filter out messages with no text content after mapping
    .filter((m) => m.content.length > 0);

  console.log(`[MovieAgent] Prepared ${messages.length} messages for prompt`);

  // Log more detailed summary of the conversation for debugging
  if (messages.length > 0) {
    console.log("[MovieAgent] Conversation Summary:");
    messages.forEach((msg, idx) => {
      console.log(`  Message ${idx}: ${msg.role} - "${msg.content.map(c => c.text).join('').substring(0, 50)}..."`);
    });

    // Extract key context clues to help with debugging
    const contextClues = extractContextClues(messages);
    if (Object.keys(contextClues).length > 0) {
      console.log("[MovieAgent] Detected context clues:");
      console.log(JSON.stringify(contextClues, null, 2));
    }
  }

  // Add a check in case history was empty or only contained non-text parts
  if (messages.length === 0) {
    console.warn(
      `[MovieAgent] No valid text messages found in history for task ${context.task.id}. Cannot proceed.`
    );
    yield {
      state: "failed",
      message: {
        role: "agent",
        parts: [{ text: "No message found to process." }],
      },
    };
    return; // Stop processing
  }

  // Include the goal from the initial task metadata if available
  const goal = context.task.metadata?.goal as string | undefined;

  // Extract conversation metadata to help with continuity
  const conversationContext = analyzeConversation(messages);

  try {
    // Log the prompt details before sending
    console.log(`[MovieAgent] Sending prompt with:
    - Goal: ${goal ?? 'none'}
    - Messages count: ${messages.length}
    - Last user message: "${messages.filter(m => m.role === 'user').pop()?.content.map(c => c.text).join('')}"
    - Detected context: ${JSON.stringify(conversationContext)}`);

    // Run the Genkit prompt
    const response = await movieAgentPrompt(
      {
        goal: goal,
        now: new Date().toISOString(),
        conversationContext: JSON.stringify(conversationContext) // Pass conversation context metadata
      },
      {
        messages,
        tools: [searchMovies, searchPeople],
      }
    );

    // Log the raw response for debugging
    console.log(`[MovieAgent] Raw response: ${response.text}`);

    const responseText = response.text; // Access the text property directly

    // More robust final state detection - check if the last part of the response
    // contains any of our expected state indicators
    const responseLines = responseText.trim().split("\n");
    let finalStateIndicator = responseLines.at(-1)?.trim().toUpperCase() || "";
    let agentReply = responseText.trim();

    // Check if the last line is a state indicator
    if (finalStateIndicator === "COMPLETED" || finalStateIndicator === "AWAITING_USER_INPUT") {
      // If it's a state indicator, remove it from the reply
      agentReply = responseLines.slice(0, -1).join("\n").trim();
    } else {
      // If there's no explicit state indicator, check for question patterns
      finalStateIndicator = responseText.match(/\?\.?$/) ? "AWAITING_USER_INPUT" : "COMPLETED";
      // Keep the full response as the agent reply
    }

    console.log(`[MovieAgent] Final state line: "${finalStateIndicator}"`);
    console.log(`[MovieAgent] Extracted reply (${agentReply.length} chars): "${agentReply.substring(0, 100)}..."`);

    let finalState: schema.TaskState = "unknown";

    // Map prompt output instruction to A2A TaskState
    if (finalStateIndicator === "COMPLETED") {
      finalState = "completed";
    } else if (finalStateIndicator === "AWAITING_USER_INPUT") {
      finalState = "input-required";
    } else {
      console.warn(
        `[MovieAgent] Unexpected final state line from prompt: ${finalStateIndicator}. Defaulting to 'completed'.`
      );
      // If the LLM didn't follow instructions, default to completed
      finalState = "completed";
    }

    // Yield the final result
    yield {
      state: finalState,
      message: {
        role: "agent",
        parts: [{ type: "text", text: agentReply }],
      },
    };

    console.log(
      `[MovieAgent] Task ${context.task.id} finished with state: ${finalState}`
    );
  } catch (error: any) {
    console.error(
      `[MovieAgent] Error processing task ${context.task.id}:`,
      error
    );
    // Yield a failed state if the prompt execution fails
    yield {
      state: "failed",
      message: {
        role: "agent",
        parts: [{ type: "text", text: `Agent error: ${error.message}` }],
      },
    };
  }
}

// --- Helper Functions for Context Management ---

/**
 * Extracts key context clues from conversation messages
 * Simplified to avoid regex pattern matching
 */
function extractContextClues(messages: MessageData[]) {
  // Instead of using regex to extract information, just collect the last user message
  // and let the model interpret the intent
  if (messages.length === 0) {
    return {};
  }

  // Find the last user message
  const lastUserMessage = [...messages].reverse().find(m => m.role === "user");

  if (!lastUserMessage) {
    return {};
  }

  // Just return the raw text for the model to interpret
  return {
    lastUserMessageText: lastUserMessage.content.map(c => c.text).join(""),
  };
}

/**
 * Analyzes the conversation to extract key context for maintaining continuity
 * Simplified to avoid regex pattern matching
 */
function analyzeConversation(messages: MessageData[]) {
  const context: {
    fullConversation: string[];
    originalQuestion?: string;
    lastUserMessage?: string;
  } = {
    fullConversation: [],
  };

  // Simply collect the full conversation without regex parsing
  const userMessages = messages.filter(m => m.role === "user");

  // Add all messages to provide full context
  context.fullConversation = messages.map(msg => {
    const role = msg.role === "user" ? "User" : "Agent";
    const text = msg.content.map(c => c.text).join("");
    return `${role}: ${text}`;
  });

  // Set the original question if available
  if (userMessages.length > 0) {
    context.originalQuestion = userMessages[0].content.map(c => c.text).join("");
  }

  // Set the last user message if available
  if (userMessages.length > 0) {
    context.lastUserMessage = userMessages[userMessages.length - 1].content.map(c => c.text).join("");
  }

  return context;
}

// --- Server Setup ---

const movieAgentCard: schema.AgentCard = {
  name: "Movie Agent",
  description:
    "An agent that can answer questions about movies and actors using TMDB.",
  url: "http://localhost:41243", // Changed from 41241 to 41243
  provider: {
    organization: "A2A Samples",
  },
  version: "0.0.1",
  capabilities: {
    // Although it yields multiple updates, it doesn't seem to implement full A2A streaming via TaskYieldUpdate artifacts
    // It uses Genkit streaming internally, but the A2A interface yields start/end messages.
    // State history seems reasonable as it processes history.
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  authentication: null,
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [
    {
      id: "general_movie_chat",
      name: "General Movie Chat",
      description:
        "Answer general questions or chat about movies, actors, directors.",
      tags: ["movies", "actors", "directors"],
      examples: [
        "Tell me about the plot of Inception.",
        "Recommend a good sci-fi movie.",
        "Who directed The Matrix?",
        "What other movies has Scarlett Johansson been in?",
        "Find action movies starring Keanu Reeves",
        "Which came out first, Jurassic Park or Terminator 2?",
      ],
    },
    // The specific tools are used internally by the Genkit agent,
    // but from the A2A perspective, it exposes one general chat skill.
  ],
};

// Create server with the task handler. Defaults to InMemoryTaskStore.
const server = new A2AServer(movieAgentHandler, { card: movieAgentCard });

// Start the server
server.start(41243); // Changed from default 41241 to 41243

console.log("[MovieAgent] Server started on http://localhost:41243");
console.log("[MovieAgent] Press Ctrl+C to stop the server");
