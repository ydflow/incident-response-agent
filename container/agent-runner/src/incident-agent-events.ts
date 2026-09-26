/** Incident events. Only trusted code paths emit; no Agent tool does. */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type AgentEventType =
  | 'IncidentCreated'
  | 'StatusChanged'
  | 'ToolCalled'
  | 'ToolResult'
  | 'EvidenceCollected'
  | 'DiagnosisCreated'
  | 'ApprovalRequested'
  | 'ApprovalDecided'
  | 'ActionExecuted'
  | 'ToolFailed';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentEvent = {
  event_id: string;
  incident_id: string;
  event_type: AgentEventType;
  timestamp: string;
  payload: Record<string, JsonValue>;
};

export class InMemoryIncidentEvents {
  private readonly recorded: AgentEvent[] = [];

  protected persist(_event: AgentEvent): void {
    // In-memory use has no disk side effect.
  }

  emit(
    incidentId: string,
    eventType: AgentEventType,
    payload: Record<string, JsonValue>,
  ): AgentEvent {
    if (!incidentId.trim()) throw new Error('incident_id is required');
    // Clone at the boundary so later mutations cannot rewrite past events.
    const serialized = JSON.stringify(payload);
    if (!serialized) throw new Error('event payload must be serializable');
    const event: AgentEvent = {
      event_id: randomUUID(),
      incident_id: incidentId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      payload: JSON.parse(serialized) as Record<string, JsonValue>,
    };
    this.persist(event);
    this.recorded.push(event);
    return event;
  }

  snapshot(): AgentEvent[] {
    return JSON.parse(JSON.stringify(this.recorded)) as AgentEvent[];
  }
}

/** Append each event as one UTF-8 JSONL line before exposing it in memory. */
export class JsonlIncidentEvents extends InMemoryIncidentEvents {
  constructor(private readonly directory: string) {
    super();
  }

  protected override persist(event: AgentEvent): void {
    if (!/^[A-Za-z0-9_-]+$/.test(event.incident_id)) {
      throw new Error('incident_id cannot be used as a JSONL filename');
    }
    mkdirSync(this.directory, { recursive: true });
    appendFileSync(
      path.join(this.directory, `${event.incident_id}.jsonl`),
      `${JSON.stringify(event)}\n`,
      { encoding: 'utf8', flag: 'a' },
    );
  }
}
