import { Router } from "express";
import { Session, Target } from "../types";

interface SkillRouterOptions {
  appId?: string;
  resolveToken: (token: string) => { session: Session; target: Target } | null;
  onSkillInvoke: (targetId: number, token: string, result: "success" | "failure", reason?: string) => void;
}

interface AlexaRequestBody {
  session?: {
    application?: {
      applicationId?: string;
    };
  };
  request?: {
    type?: string;
    intent?: {
      name?: string;
      slots?: Record<string, { value?: string }>;
    };
  };
}

function responseWithSpeech(text: string) {
  return {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text,
      },
      shouldEndSession: true,
    },
  };
}

export function createSkillRouter(options: SkillRouterOptions): Router {
  const router = Router();

  router.post("/alexa/skill", (req, res) => {
    const body = req.body as AlexaRequestBody;

    if (options.appId) {
      const requestAppId = body.session?.application?.applicationId;
      if (requestAppId !== options.appId) {
        res.status(403).json(responseWithSpeech("Invalid application ID."));
        return;
      }
    }

    const requestType = body.request?.type;
    if (requestType === "LaunchRequest") {
      res.json(responseWithSpeech("AirBridge ist bereit. Sage: spiele token."));
      return;
    }

    if (requestType === "IntentRequest") {
      const intentName = body.request?.intent?.name;
      if (intentName !== "StartStreamIntent") {
        res.json(responseWithSpeech("Dieses Kommando wird nicht unterstützt."));
        return;
      }

      const token =
        body.request?.intent?.slots?.token?.value ??
        body.request?.intent?.slots?.streamToken?.value ??
        "";

      if (!token) {
        res.json(responseWithSpeech("Kein Stream Token erkannt."));
        return;
      }

      const resolved = options.resolveToken(token);
      if (!resolved) {
        options.onSkillInvoke(-1, token, "failure", "token_not_found");
        res.json(responseWithSpeech("Der Stream ist nicht verfügbar."));
        return;
      }

      options.onSkillInvoke(resolved.target.id, token, "success");
      res.json({
        version: "1.0",
        response: {
          shouldEndSession: true,
          directives: [
            {
              type: "AudioPlayer.Play",
              playBehavior: "REPLACE_ALL",
              audioItem: {
                stream: {
                  token: resolved.session.stream_token,
                  url: resolved.session.stream_url,
                  offsetInMilliseconds: 0,
                },
              },
            },
          ],
        },
      });
      return;
    }

    res.json(responseWithSpeech("Ungültige Anfrage."));
  });

  return router;
}
