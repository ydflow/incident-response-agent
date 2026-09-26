/** Keep successful incident Evidence in memory across later Tool failures. */
export type CollectedIncidentEvidence = {
  evidence_id: string;
  incident_id: string;
  source: string;
  timestamp: string;
  content: string;
  correlation_id: string;
};

export class InMemoryIncidentEvidence {
  private readonly byIncident = new Map<
    string,
    Map<string, CollectedIncidentEvidence>
  >();

  collect(evidence: CollectedIncidentEvidence): void {
    let collected = this.byIncident.get(evidence.incident_id);
    if (!collected) {
      collected = new Map();
      this.byIncident.set(evidence.incident_id, collected);
    }
    collected.set(evidence.evidence_id, { ...evidence });
  }

  forIncident(incidentId: string): CollectedIncidentEvidence[] {
    return [...(this.byIncident.get(incidentId)?.values() ?? [])].map(
      (evidence) => ({ ...evidence }),
    );
  }
}
