type EnrichmentAvailability = {
  hasMissionDescription: boolean;
  hasOperatorName: boolean;
  hasOperatorDescription: boolean;
};

export function enrichmentPrompt({
  hasMissionDescription,
  hasOperatorName,
  hasOperatorDescription,
}: EnrichmentAvailability) {
  if (!hasOperatorName) {
    return hasMissionDescription
      ? "Operator name and description are not available from the direct catalog sources. Select Enhance with AI to research them."
      : "Mission description and operator details are not available yet. Select Enhance with AI to research them.";
  }
  if (hasMissionDescription && !hasOperatorDescription) {
    return "Operator description is not available yet. Select Enhance with AI to research it.";
  }
  if (!hasMissionDescription && hasOperatorDescription) {
    return "Mission description is not available yet. Select Enhance with AI to research it.";
  }
  return "Mission and operator descriptions are not available yet. Select Enhance with AI to research them.";
}
