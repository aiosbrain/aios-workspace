/**
 * Guards URLs sourced from the brain/connector API surface (OAuth authorize_url, catalog
 * docs.token_create_url) before they reach a DOM navigation sink (window.open, <a href>).
 * Each connector's provider lives on a different domain, so this can't pin a host — it
 * requires a plain https:// URL with no embedded credentials, closing off javascript:/data:
 * schemes and userinfo look-alike redirects (https://real-host@evil.com/...).
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}
