export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SmallModelInfo = { provider: string; id: string; thinkingLevel: ThinkingLevel };
export type SelectedSmallModel = { model: ModelInfo; thinkingLevel: ThinkingLevel };

type ModelInfo = { provider: string; id: string };

const ANTIGRAVITY_GEMINI_FLASH: SmallModelInfo = {
  provider: "google-antigravity",
  id: "gemini-3-flash",
  thinkingLevel: "low",
};

const DEFAULT_SMALL_MODEL: SmallModelInfo = ANTIGRAVITY_GEMINI_FLASH;

export function getSmallModelFromProvider(
  modelRegistry: { getAvailable(): ModelInfo[] },
): SelectedSmallModel | null {
  const model = modelRegistry.getAvailable().find(
    (candidate) =>
      candidate.provider === DEFAULT_SMALL_MODEL.provider &&
      candidate.id === DEFAULT_SMALL_MODEL.id,
  );

  if (!model) return null;

  return {
    model,
    thinkingLevel: DEFAULT_SMALL_MODEL.thinkingLevel,
  };
}
