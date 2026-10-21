import "./auth-recovery.css";

export function AuthRecovery({ href }: { href?: string }) {
  if (!href) return null;
  return (
    <div className="auth-recovery" role="status">
      <p>
        새 탭에서 다시 인증해 주세요. 이 탭의 입력 내용은 유지됩니다. 인증 후
        돌아와 내용을 확인한 뒤 다시 처리해 주세요.
      </p>
      <a
        className="button button-secondary"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        다시 인증하기 (새 탭)
      </a>
    </div>
  );
}
