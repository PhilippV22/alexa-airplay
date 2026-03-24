export type TargetType = "bluetooth";

export type TargetStatus = "active" | "error" | "disabled";

export type ErrorCode = "BT_CONNECT_FAILED" | "TRANSCODER_FAILED";

export interface Target {
  id: number;
  name: string;
  type: TargetType;
  bluetooth_mac: string | null;
  airplay_name: string;
  enabled: number;
  status: TargetStatus;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: number;
  actor: string;
  action: string;
  target_id: number | null;
  result: "success" | "failure";
  details_json: string;
  timestamp: string;
}

export interface CreateTargetInput {
  name: string;
  type: TargetType;
  bluetooth_mac?: string;
  airplay_name?: string;
  enabled?: boolean;
}

export interface UpdateTargetInput {
  name?: string;
  bluetooth_mac?: string | null;
  airplay_name?: string;
  enabled?: boolean;
  status?: TargetStatus;
}

export interface ManagedProcessInfo {
  targetId: number;
  shairportPid: number | null;
  ffmpegPid: number | null;
  state: "starting" | "running" | "stopped" | "error";
}
