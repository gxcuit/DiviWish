import type { BollPosition } from "./types.ts";

export const bollLabels: Record<BollPosition, { short: string; text: string; tone: string }> = {
  above_upper: { short: "上", text: "高于上轨", tone: "upper" },
  at_upper: { short: "上", text: "达到上轨", tone: "upper" },
  near_upper: { short: "上", text: "接近上轨（距离不超过通道宽度的 5%，尚未触轨）", tone: "nearUpper" },
  upper_half: { short: "高", text: "中轨与上轨之间", tone: "high" },
  at_middle: { short: "中", text: "中轨附近（距离不超过通道宽度的 5%）", tone: "middle" },
  lower_half: { short: "低", text: "下轨与中轨之间", tone: "low" },
  near_lower: { short: "下", text: "接近下轨（距离不超过通道宽度的 5%，尚未触轨）", tone: "nearLower" },
  at_lower: { short: "下", text: "达到下轨", tone: "lower" },
  below_lower: { short: "下", text: "低于下轨", tone: "lower" },
  flat: { short: "平", text: "三轨重合", tone: "neutral" },
  unknown: { short: "—", text: "暂无有效数据", tone: "neutral" },
};
