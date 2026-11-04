export interface NotebookHostState {
  writing: boolean;
  busy: boolean;
  isDirty(): boolean;
  flush(): Promise<boolean>;
}

export type NotebookHostStateChange = (state: NotebookHostState | null) => void;

export interface NotebookPageProps {
  isActive?: boolean;
  onHostStateChange?: NotebookHostStateChange;
}
