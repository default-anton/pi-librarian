export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AuthMode = "oauth" | "api-key";
export type AuthSource = "runtime" | "api_key" | "oauth" | "env" | "fallback" | "none";

export type SmallModelInfo = { provider: string; id: string; thinkingLevel: ThinkingLevel };
export type SelectedSmallModel = {
  model: ModelInfo;
  thinkingLevel: ThinkingLevel;
  authMode: AuthMode;
  authSource: AuthSource;
  reason: string;
};

type ModelInfo = { provider: string; id: string };

type ModelRegistryLike = {
  getAvailable(): ModelInfo[];
  isUsingOAuth?(model: ModelInfo): boolean;
  getAuthSource?(provider: string): AuthSource;
};

type AuthResolution = {
  authMode: AuthMode;
  authSource: AuthSource;
  basis: string;
};

const ANTIGRAVITY_GEMINI_FLASH: SmallModelInfo = {
  provider: "google-antigravity",
  id: "gemini-3-flash",
  thinkingLevel: "low",
};

const VERTEX_PROVIDER = "google-vertex";
const GEMINI_PROVIDER = "google";

const GEMINI_3_FLASH_MODEL_IDS = ["gemini-3-flash", "gemini-3-flash-preview"] as const;
const HAIKU_4_5_MODEL_IDS = ["claude-haiku-4-5"] as const;

function exactProviderModel(available: ModelInfo[], provider: string, modelId: string): ModelInfo | null {
  const found = available.find((candidate) => candidate.provider === provider && candidate.id === modelId);
  return found ?? null;
}

function findBestGeminiFlash(available: ModelInfo[], provider?: string): ModelInfo | null {
  const candidates = provider ? available.filter((m) => m.provider === provider) : available;

  for (const preferredId of GEMINI_3_FLASH_MODEL_IDS) {
    const exact = candidates.find((candidate) => candidate.id === preferredId);
    if (exact) return exact;
  }

  const startsWith = candidates.find((candidate) => candidate.id.startsWith("gemini-3-flash"));
  if (startsWith) return startsWith;

  const contains = candidates.find((candidate) => candidate.id.includes("gemini-3-flash"));
  return contains ?? null;
}

function findBestHaiku45(available: ModelInfo[], provider: string): ModelInfo | null {
  const candidates = available.filter((m) => m.provider === provider);

  for (const preferredId of HAIKU_4_5_MODEL_IDS) {
    const exact = candidates.find((candidate) => candidate.id === preferredId);
    if (exact) return exact;
  }

  const startsWith = candidates.find((candidate) => candidate.id.startsWith("claude-haiku-4-5"));
  if (startsWith) return startsWith;

  const contains = candidates.find((candidate) => candidate.id.includes("haiku-4-5"));
  return contains ?? null;
}

function detectAuthResolution(modelRegistry: ModelRegistryLike, currentModel: ModelInfo | undefined): AuthResolution {
  if (!currentModel) {
    return {
      authMode: "api-key",
      authSource: "none",
      basis: "no current model; default to api-key policy",
    };
  }

  if (typeof modelRegistry.getAuthSource === "function") {
    const authSource = modelRegistry.getAuthSource(currentModel.provider);
    const authMode = authSource === "oauth" ? "oauth" : "api-key";
    return {
      authMode,
      authSource,
      basis: `provider auth source=${authSource}`,
    };
  }

  const usesOAuth = modelRegistry.isUsingOAuth?.(currentModel) ?? false;
  return {
    authMode: usesOAuth ? "oauth" : "api-key",
    authSource: usesOAuth ? "oauth" : "none",
    basis: usesOAuth ? "derived from isUsingOAuth" : "derived from isUsingOAuth=false",
  };
}

function selection(
  model: ModelInfo,
  thinkingLevel: ThinkingLevel,
  authResolution: AuthResolution,
  reason: string,
): SelectedSmallModel {
  return {
    model,
    thinkingLevel,
    authMode: authResolution.authMode,
    authSource: authResolution.authSource,
    reason: `${reason}; ${authResolution.basis}`,
  };
}

function fallbackSelection(
  available: ModelInfo[],
  currentModel: ModelInfo | undefined,
  authResolution: AuthResolution,
): SelectedSmallModel | null {
  const currentProvider = currentModel?.provider;

  if (currentProvider) {
    const currentProviderGeminiFlash = findBestGeminiFlash(available, currentProvider);
    if (currentProviderGeminiFlash) {
      return selection(currentProviderGeminiFlash, "low", authResolution, "fallback: current provider gemini-3-flash");
    }

    const currentProviderHaiku45 = findBestHaiku45(available, currentProvider);
    if (currentProviderHaiku45) {
      return selection(currentProviderHaiku45, "low", authResolution, "fallback: current provider claude-haiku-4-5");
    }
  }

  if (currentModel) {
    const sameModel = exactProviderModel(available, currentModel.provider, currentModel.id);
    if (sameModel) {
      return selection(sameModel, "low", authResolution, "fallback: current model with low thinking");
    }
  }

  return null;
}

export function getSmallModelFromProvider(
  modelRegistry: ModelRegistryLike,
  currentModel: ModelInfo | undefined,
): SelectedSmallModel | null {
  const available = modelRegistry.getAvailable();
  const authResolution = detectAuthResolution(modelRegistry, currentModel);

  if (authResolution.authMode === "oauth") {
    const antigravityGeminiFlash = exactProviderModel(
      available,
      ANTIGRAVITY_GEMINI_FLASH.provider,
      ANTIGRAVITY_GEMINI_FLASH.id,
    );
    if (antigravityGeminiFlash) {
      return selection(
        antigravityGeminiFlash,
        ANTIGRAVITY_GEMINI_FLASH.thinkingLevel,
        authResolution,
        "oauth: prefer google-antigravity/gemini-3-flash",
      );
    }

    return fallbackSelection(available, currentModel, authResolution);
  }

  const vertexGeminiFlash = findBestGeminiFlash(available, VERTEX_PROVIDER);
  if (vertexGeminiFlash) {
    return selection(vertexGeminiFlash, "low", authResolution, "api-key: prefer google-vertex gemini-3-flash");
  }

  const geminiGeminiFlash = findBestGeminiFlash(available, GEMINI_PROVIDER);
  if (geminiGeminiFlash) {
    return selection(geminiGeminiFlash, "low", authResolution, "api-key: prefer google gemini-3-flash");
  }

  return fallbackSelection(available, currentModel, authResolution);
}
