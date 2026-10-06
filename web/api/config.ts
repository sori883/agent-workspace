export type ApiConfig = { apiToken: string; apiOrigin: string };

export function validateApiConfig(config: ApiConfig): ApiConfig {
  const origin = new URL(config.apiOrigin);
  if (config.apiToken.length < 32 || origin.origin !== config.apiOrigin ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)))) throw new Error("Invalid API configuration.");
  return config;
}
