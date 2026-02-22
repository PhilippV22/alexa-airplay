declare module "alexa-cookie2" {
  interface AlexaCookieResult {
    localCookie?: string;
    loginCookie?: string;
    cookie?: string;
    csrf?: string;
  }

  interface AlexaCookieApi {
    generateAlexaCookie(
      options: Record<string, unknown>,
      callback: (err: Error | null, result: AlexaCookieResult | null) => void,
    ): void;
    stopProxyServer(callback?: () => void): void;
  }

  const api: AlexaCookieApi;
  export default api;
}
