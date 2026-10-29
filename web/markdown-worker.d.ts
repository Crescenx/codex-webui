declare module '@markdown-worker' {
  const MarkdownWorker: new (options?: WorkerOptions) => Worker;
  export default MarkdownWorker;
}
