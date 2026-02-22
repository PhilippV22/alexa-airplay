declare module "alexa-remote2" {
  class AlexaRemote {
    init(config: Record<string, unknown>, callback: (err?: Error | null) => void): void;
    sendSequenceCommand(
      serialOrName: string,
      command: string,
      value?: string,
      callback?: (err?: Error | null, response?: unknown) => void,
    ): void;
  }

  export = AlexaRemote;
}
