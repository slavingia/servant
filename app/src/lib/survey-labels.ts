import { dayLabel } from "./time-label.ts";

// The words for a survey response's review state and status. Every screen shows these, never the stored values.
export const surveyVisibilityLabels = { pending: "Needs review", reviewed: "Reviewed", hidden: "Hidden" } as const;
export const surveyStatusLabels = { open: "Open", planned: "Planned", resolved: "Resolved" } as const;

type Meta = { visibility: keyof typeof surveyVisibilityLabels; status: keyof typeof surveyStatusLabels; createdAt: number };

// One line beside a response's rating: "Needs review · Open · Yesterday". The day reads as it does on messages.
export const responseMeta = (response: Meta, now = Date.now()) =>
  `${surveyVisibilityLabels[response.visibility]} · ${surveyStatusLabels[response.status]} · ${dayLabel(response.createdAt, now)}`;
