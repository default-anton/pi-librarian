export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SmallModelInfo = { provider: string; id: string; thinkingLevel: ThinkingLevel };

type ModelInfo = { provider: string; id: string };

const ANTIGRAVITY_GEMINI_FLASH: SmallModelInfo = { provider: "google-antigravity", id: "gemini-3-flash", thinkingLevel: "off" };
const DEFAULT_SMALL_MODEL: SmallModelInfo = ANTIGRAVITY_GEMINI_FLASH;

export function getSmallModelFromProvider(
  modelRegistry: { getAvailable(): ModelInfo[] },
): ModelInfo | null {
  const subModel = modelRegistry.getAvailable().find(
    (m) => m.provider === DEFAULT_SMALL_MODEL.provider && m.id === DEFAULT_SMALL_MODEL.id,
  );

  return subModel ?? null;
}
