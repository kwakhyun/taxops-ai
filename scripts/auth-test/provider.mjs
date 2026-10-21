import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import Provider, { errors } from "oidc-provider";
import { TOTP } from "otpauth";

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

// An actual OIDC authorization server, never imported by the application.
// Accounts, signing keys, consent and OTP replay state exist for one test run only.
export async function startTestIdentityProvider({
  issuer,
  appUrl,
  clientId,
  clientSecret,
  audience,
  tenantId,
  accounts,
}) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.TAXOPS_AUTH_TEST_RUN !== "1"
  ) {
    throw new Error(
      "The test identity provider requires an explicit non-production test run",
    );
  }
  for (const value of [issuer, appUrl]) {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password
    ) {
      throw new Error("Test identity services must use IPv4 loopback HTTP");
    }
  }
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const key = {
    ...(await exportJWK(privateKey)),
    alg: "ES256",
    use: "sig",
    kid: "ephemeral-test-key",
  };
  const salt = randomBytes(32);
  const users = new Map(
    Object.entries(accounts).map(([name, account]) => [
      name,
      {
        ...account,
        subject: `oidc|${name}`,
        passwordHash: scryptSync(account.password, salt, 32),
        lastCounter: -1,
      },
    ]),
  );
  const interactions = new Map();
  const metrics = {
    passwordDenied: 0,
    otpDenied: 0,
    authenticated: 0,
    codeExchanges: 0,
    pkceExchanges: 0,
  };
  const provider = new Provider(issuer, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [`${appUrl}/api/auth/callback`],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        id_token_signed_response_alg: "ES256",
      },
    ],
    jwks: { keys: [key] },
    cookies: { keys: [randomBytes(32).toString("hex")] },
    responseTypes: ["code"],
    pkce: { required: () => true },
    claims: {
      openid: ["sub", "tenant_id"],
      profile: ["name"],
      email: ["email"],
      acr: null,
      auth_time: null,
    },
    conformIdTokenClaims: false,
    acrValues: ["urn:taxops:acr:mfa"],
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== audience) throw new errors.InvalidTarget();
          return {
            scope: "review:decide",
            audience,
            accessTokenTTL: 900,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "ES256" } },
          };
        },
      },
    },
    ttl: {
      AuthorizationCode: 120,
      IdToken: 900,
      Interaction: 600,
      Session: 1800,
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: (_ctx, subject) => {
      const user = [...users.values()].find(
        (account) => account.subject === subject,
      );
      return (
        user && {
          accountId: subject,
          claims: () => ({
            sub: subject,
            tenant_id: tenantId,
            name: subject,
            email: `${subject.slice(5)}@auth-test.invalid`,
          }),
        }
      );
    },
    // The single, fixed first-party test client is pre-consented. Authentication is never skipped.
    loadExistingGrant: async (ctx) => {
      if (!ctx.oidc.session.accountId) return undefined;
      const grant = new provider.Grant({
        accountId: ctx.oidc.session.accountId,
        clientId,
      });
      grant.addOIDCScope("openid profile email");
      grant.addResourceScope(audience, "review:decide");
      await grant.save();
      return grant;
    },
    extraTokenClaims: (ctx) => {
      const code = ctx.oidc.entities.AuthorizationCode;
      if (!code || code.acr !== "urn:taxops:acr:mfa" || !code.authTime)
        throw new Error("MFA-bound authorization code required");
      return {
        tenant_id: tenantId,
        auth_time: code.authTime,
        acr: code.acr,
        amr: code.amr,
      };
    },
  });
  provider.on("grant.success", (ctx) => {
    metrics.codeExchanges++;
    if (ctx.oidc.params.code_verifier) metrics.pkceExchanges++;
  });

  function showLogin(response, uid, csrf, message = "", status = 200) {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        // Chromium applies form-action to redirect targets as well as the form POST.
        `default-src 'none'; form-action 'self' ${new URL(appUrl).origin}; frame-ancestors 'none'; base-uri 'none'`,
    });
    response.end(
      `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TaxOps 테스트 인증기관</title><body><main><h1>테스트 계정 로그인</h1><p>로컬 검증 전용입니다. 실제 업무용 계정은 입력하지 마세요.</p>${message ? `<p role="alert">${escapeHtml(message)}</p>` : ""}<form method="post" action="/interaction/${encodeURIComponent(uid)}"><input type="hidden" name="csrf" value="${csrf}"><p><label>테스트 계정 <input name="username" autocomplete="username" required></label></p><p><label>비밀번호 <input name="password" type="password" autocomplete="current-password" required></label></p><p><label>인증번호 <input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label></p><button type="submit">인증하기</button><button name="cancel" value="1" formnovalidate>로그인 취소</button></form></main></body></html>`,
    );
  }
  const callback = provider.callback();
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== new URL(issuer).host) {
        response.writeHead(400).end();
        return;
      }
      const path = new URL(request.url, issuer).pathname;
      if (!path.startsWith("/interaction/")) {
        callback(request, response);
        return;
      }
      const details = await provider.interactionDetails(request, response);
      if (
        path !== `/interaction/${details.uid}` ||
        details.prompt.name !== "login"
      ) {
        response.writeHead(400).end("Invalid interaction");
        return;
      }
      for (const [uid, state] of interactions)
        if (state.expires < Date.now()) interactions.delete(uid);
      let state = interactions.get(details.uid);
      if (!state) {
        state = {
          csrf: randomBytes(32).toString("hex"),
          attempts: 0,
          expires: Date.now() + 600_000,
        };
        interactions.set(details.uid, state);
      }
      if (request.method === "GET") {
        showLogin(response, details.uid, state.csrf);
        return;
      }
      if (request.method !== "POST" || request.headers.origin !== issuer) {
        response.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 4096) {
          response.writeHead(413).end();
          return;
        }
      }
      const form = new URLSearchParams(body);
      if (form.get("csrf") !== state.csrf) {
        response.writeHead(403).end();
        return;
      }
      if (form.get("cancel") === "1") {
        interactions.delete(details.uid);
        await provider.interactionFinished(
          request,
          response,
          { error: "access_denied", error_description: "Login cancelled" },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      if (++state.attempts > 5) {
        response.writeHead(429).end("Too many attempts");
        return;
      }
      const user = users.get(form.get("username"));
      const passwordMatches =
        user &&
        timingSafeEqual(
          scryptSync(form.get("password") ?? "", salt, 32),
          user.passwordHash,
        );
      if (!passwordMatches) {
        metrics.passwordDenied++;
        showLogin(
          response,
          details.uid,
          state.csrf,
          "계정 또는 비밀번호를 확인해 주세요.",
          401,
        );
        return;
      }
      const totp = new TOTP({ secret: user.otpSecret });
      const delta = totp.validate({ token: form.get("otp") ?? "", window: 1 });
      const counter =
        Math.floor(Date.now() / 1000 / totp.period) + (delta ?? 0);
      if (delta === null || counter <= user.lastCounter) {
        metrics.otpDenied++;
        showLogin(
          response,
          details.uid,
          state.csrf,
          "인증번호가 유효하지 않거나 이미 사용되었습니다.",
          401,
        );
        return;
      }
      user.lastCounter = counter;
      metrics.authenticated++;
      interactions.delete(details.uid);
      await provider.interactionFinished(
        request,
        response,
        {
          login: {
            accountId: user.subject,
            acr: "urn:taxops:acr:mfa",
            amr: ["pwd", "otp"],
            ts: Math.floor(Date.now() / 1000),
          },
        },
        { mergeWithLastSubmission: false },
      );
    } catch {
      if (!response.headersSent)
        response.writeHead(500, { "content-type": "text/plain" });
      response.end("Test identity provider could not complete the request");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(new URL(issuer).port), "127.0.0.1", resolve);
  });
  return {
    metrics,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
