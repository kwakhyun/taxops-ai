import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";

export default function NotFoundPage() {
  return (
    <section className="empty-state card">
      <span className="empty-state-icon">
        <FileQuestion size={24} />
      </span>
      <h1>요청한 화면을 찾을 수 없습니다.</h1>
      <p>삭제되었거나 현재 업무 공간에서 접근할 수 없는 경로입니다.</p>
      <Link className="button button-primary" href="/">
        <ArrowLeft size={15} /> 업무 현황으로
      </Link>
    </section>
  );
}
