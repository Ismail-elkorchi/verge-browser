export interface DownloadRequest {
  readonly url: string;
  readonly directory: string;
  readonly maxBytes: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface DownloadResult {
  readonly path: string;
  readonly fileName: string;
  readonly receivedBytes: number;
  readonly totalBytes: number | null;
}

export interface BrowserServices {
  writeTextFile(path: string, content: string): Promise<void>;
  downloadFile(request: DownloadRequest): Promise<DownloadResult>;
  openExternal(target: string): Promise<void>;
  openPath(path: string): Promise<void>;
}
