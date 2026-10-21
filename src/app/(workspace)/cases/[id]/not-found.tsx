import Link from "next/link";
import { BriefcaseBusiness } from "lucide-react";

export default function CaseNotFound() {
  return (
    <div className="card empty-state">
      <div>
        <span className="empty-state-icon">
          <BriefcaseBusiness size={22} />
        </span>
        <h1>세무 업무를 찾을 수 없습니다.</h1>
        <p>
          삭제되었거나 현재 업무 공간에서 접근할 권한이 없는 세무 업무입니다.
        </p>
        <Link className="button button-primary" href="/cases">
          세무 업무 목록으로
        </Link>
      </div>
    </div>
  );
}
