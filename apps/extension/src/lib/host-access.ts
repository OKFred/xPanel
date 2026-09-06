export const ALL_HTTP_HOST_ORIGINS = ["http://*/*", "https://*/*"] as const;

function isHttpHostOrigin(origin: string): boolean {
  return origin.startsWith("http://") || origin.startsWith("https://");
}

export async function hasAllHttpHostAccess(): Promise<boolean> {
  return chrome.permissions.contains({
    origins: [...ALL_HTTP_HOST_ORIGINS],
  });
}

export async function grantAllHttpHostAccess(): Promise<boolean> {
  return chrome.permissions.request({
    origins: [...ALL_HTTP_HOST_ORIGINS],
  });
}

export async function revokeAllHttpHostAccess(): Promise<boolean> {
  const permissions = await chrome.permissions.getAll();
  const origins = (permissions.origins ?? []).filter(isHttpHostOrigin);
  if (origins.length === 0) return true;
  return chrome.permissions.remove({ origins });
}
