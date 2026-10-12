export function needsRemoteSignIn(webUI: boolean, remoteName: string | undefined, workspaceHost: boolean): boolean {
  return webUI || (Boolean(remoteName) && workspaceHost);
}
