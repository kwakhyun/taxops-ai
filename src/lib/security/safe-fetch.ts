export function fetchWithoutRedirect(
  input: string | URL | Request,
  init: RequestInit = {},
) {
  return fetch(input, { ...init, redirect: "error" });
}
