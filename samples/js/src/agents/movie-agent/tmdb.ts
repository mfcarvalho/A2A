/**
 * Utility function to call the TMDB API
 * @param endpoint The TMDB API endpoint (e.g., 'movie', 'person')
 * @param query The search query
 * @returns Promise that resolves to the API response data
 */
export async function callTmdbApi(endpoint: string, query: string) {
  // Validate API key
  // const apiKey = process.env.TMDB_API_KEY;
  const apiKey = "fe5848406eb6baa1d8a9781e8cd80c68"; // Replace with your actual API key
  if (!apiKey) {
    throw new Error("TMDB_API_KEY environment variable is not set");
  }

  try {
    // Make request to TMDB API
    const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
    url.searchParams.append("api_key", apiKey);
    url.searchParams.append("query", query);
    url.searchParams.append("include_adult", "false");
    url.searchParams.append("language", "en-US");
    url.searchParams.append("page", "1");

    const response = await fetch(url.toString());

    console.log(
      `[TMDB API] Fetching ${endpoint} with query "${query}" - Status: ${response.status}`)

    if (!response.ok) {
      throw new Error(
        `TMDB API error: ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error(`Error calling TMDB API (${endpoint}):`, error);
    throw error;
  }
}
