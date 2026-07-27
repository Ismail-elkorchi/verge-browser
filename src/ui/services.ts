export interface BrowserServices {
  writeTextFile(path: string, content: string): Promise<void>;
  writeCsvFile(path: string, rows: readonly (readonly string[])[]): Promise<void>;
  openExternal(target: string): Promise<void>;
  editTextExternally(initialText: string, label: string): Promise<string>;
}
