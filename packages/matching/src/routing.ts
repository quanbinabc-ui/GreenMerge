import { RoutingRuleSchema, type IncidentRouter, type IncidentType, type Location, type RoutingRule } from '@civicmerge/contracts';

const DEFAULT_TEAMS: Record<IncidentType, string> = {
  pothole: 'Tổ đường bộ (thí điểm)',
  trash: 'Tổ vệ sinh (thí điểm)',
  flood: 'Tổ thoát nước (thí điểm)',
};

function matchesRegion(rule: RoutingRule, location: Location | null | undefined): boolean {
  const hasBox = rule.minLat != null && rule.maxLat != null && rule.minLng != null && rule.maxLng != null;
  if (!hasBox) return true;
  if (!location) return false;
  return (
    location.latitude >= rule.minLat!
    && location.latitude <= rule.maxLat!
    && location.longitude >= rule.minLng!
    && location.longitude <= rule.maxLng!
  );
}

export function createRuleRouter(rules: readonly RoutingRule[]): IncidentRouter {
  const validated = rules.map(rule => RoutingRuleSchema.parse(rule)).filter(rule => rule.active);
  validated.sort((a, b) => b.priority - a.priority);

  return {
    assignTeam(type: IncidentType, location?: Location | null): string {
      const matched = validated.find(rule => rule.incidentType === type && matchesRegion(rule, location));
      return matched ? matched.teamName : DEFAULT_TEAMS[type];
    },
  };
}
