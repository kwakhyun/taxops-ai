import Link from "next/link";
import { BriefcaseBusiness } from "lucide-react";

export default function CaseNotFound() {
  return (
    <div className="card empty-state">
      <div>
        <span className="empty-state-icon">
          <BriefcaseBusiness size={22} />
        </span>
        <h3>케이스를 찾을 수 없습니다.</h3>
        <p>
          삭제되었거나 현재 워크스페이스에서 접근할 권한이 없는 케이스입니다.
        </p>
        <Link className="button button-primary" href="/cases">
          케이스 목록으로
        </Link>
      </div>
    </div>
  );
}
