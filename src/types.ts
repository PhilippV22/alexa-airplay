export type TargetType = "device" | "group" | "bluetooth";

export type TargetStatus =
  | "active"
  | "blocked_group_native_unsupported"
  | "error"
  | "disabled";

export type SessionState = "idle" | "buffering" | "playing" | "stopped" | "error";

export type ErrorCode =
  | "GROUP_NATIVE_UNSUPPORTED"
  | "ALEXA_AUTH_FAILED"
  | "ALEXA_INVOKE_FAILED"
  | "TUNNEL_UNAVAILABLE"
  | "TRANSCODER_FAILED"
  | "BT_CONNECT_FAILED";

export interface Target {
  id: number;
  name: string;
  type: TargetType;
  alexa_device_id: string | null;
  alexa_group_id: string | null;
  bluetooth_mac: string | null;
  airplay_name: string;
  enabled: number;
  status: TargetStatus;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: number;
  target_id: number;
  state: SessionState;
  stream_url: string;
  stream_token: string;
  started_at: string;
  ended_at: string | null;
  error_code: ErrorCode | null;
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
  alexa_device_id?: string;
  alexa_group_id?: string;
  bluetooth_mac?: string;
  airplay_name?: string;
  enabled?: boolean;
}

export interface UpdateTargetInput {
  name?: string;
  alexa_device_id?: string | null;
  alexa_group_id?: string | null;
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
  lastPlaylistMtimeMs: number;
}
