export const SCOPE_FILE: string;
export const SCOPE_FULL: string;
export interface DriveConfig {
  configured: boolean;
  missing: string[];
  problems: string[];
  scope: string;
  apiUrl: string;
  tokenUrl: string;
  key: { client_email: string; private_key: string } | null;
  folderId: string;
}
export interface DriveFile { id: string; name: string; size: number; owned: boolean }
export interface DriveClient {
  listFolder(): Promise<DriveFile[]>;
  deleteFile(id: string): Promise<void>;
  uploadFile(file: string, name: string, contentType: string): Promise<{ id: string; name: string; size: number }>;
  accessToken(force?: boolean): Promise<string>;
}
export function driveConfig(env?: Record<string, string | undefined>): DriveConfig;
export function signJwt(key: { client_email: string; private_key: string }, scope: string, audience: string, nowSec: number): string;
export function createDriveClient(cfg: DriveConfig, opts?: { now?: () => number }): DriveClient;
