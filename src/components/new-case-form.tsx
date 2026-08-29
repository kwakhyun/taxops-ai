"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const steps = ["기본 정보", "업무 범위", "담당자", "확인"];

export function NewCaseForm({
  owner,
  reviewers,
}: {
  owner: { name: string; initials: string };
  reviewers: Array<{ id: string; name: string; role: "REVIEWER" | "ADMIN" }>;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [form, setForm] = useState({
    client: "한빛테크 주식회사",
    taxType: "부가가치세",
    period: "2026년 제1기 예정신고",
    summary: "매입세액 공제와 영세율 첨부서류 검토",
    dueDate: "2026-10-26",
    reviewerId: reviewers[0]?.id ?? "",
  });
  const selectedReviewer = reviewers.find(
    (reviewer) => reviewer.id === form.reviewerId,
  );

  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          dueDate: form.dueDate.replace(/-/g, ". "),
        }),
      });
      const payload = (await response.json()) as {
        data?: { id: string };
        error?: { message: string };
      };
      if (!response.ok || !payload.data)
        throw new Error(payload.error?.message ?? "업무 등록 실패");
      router.push(`/cases/${payload.data.id}`);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "세무 업무를 등록하지 못했습니다.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="new-case-layout">
      <aside className="card form-steps">
        <span className="card-kicker">단계별 등록</span>
        <h2>세무 업무 등록</h2>
        <p>필수 정보를 입력하면 자료 수집과 AI 분석을 시작할 수 있습니다.</p>
        <ol>
          {steps.map((label, index) => (
            <li
              key={label}
              className={index === step ? "form-step-active" : ""}
            >
              <span>{index < step ? <Check size={12} /> : index + 1}</span>
              <div>
                <strong>{label}</strong>
                <small>
                  {index < step
                    ? "입력 완료"
                    : index === step
                      ? "입력 중"
                      : "대기"}
                </small>
              </div>
            </li>
          ))}
        </ol>
        <div className="form-security-note">
          <ShieldCheck size={17} />
          <span>
            모든 업무 자료는 현재 조직 안에서 분리 보관되며 감사 로그에
            기록됩니다.
          </span>
        </div>
      </aside>

      <section className="card form-panel">
        <div className="form-panel-header">
          <div>
            <span className="eyebrow">
              총 {steps.length}단계 중 {step + 1}단계
            </span>
            <h1>{steps[step]}</h1>
            <p>
              {step === 0 && "고객사와 검토할 세목을 입력해 주세요."}
              {step === 1 && "신고 대상 기간과 핵심 검토 범위를 입력해 주세요."}
              {step === 2 && "검토자와 업무 마감일을 지정해 주세요."}
              {step === 3 && "입력 내용을 확인하고 세무 업무를 등록합니다."}
            </p>
          </div>
          <span className="step-counter">0{step + 1}</span>
        </div>

        <div className="form-panel-body">
          {step === 0 ? (
            <div className="form-grid">
              <label className="form-field form-field-wide">
                <span>고객사명</span>
                <input
                  value={form.client}
                  onChange={(event) => update("client", event.target.value)}
                  placeholder="법인명 또는 개인사업자 상호"
                />
                <small>사업자등록증에 기재된 명칭을 입력해 주세요.</small>
              </label>
              <label className="form-field">
                <span>세목</span>
                <select
                  value={form.taxType}
                  onChange={(event) => update("taxType", event.target.value)}
                >
                  <option>부가가치세</option>
                  <option>법인세</option>
                  <option>원천세</option>
                  <option>소득세</option>
                  <option>국제조세</option>
                </select>
              </label>
              <label className="form-field">
                <span>업무 유형</span>
                <select defaultValue="신고 검토">
                  <option>신고 검토</option>
                  <option>세무조사 대응</option>
                  <option>세무 진단</option>
                  <option>유권해석 검토</option>
                </select>
              </label>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="form-grid">
              <label className="form-field form-field-wide">
                <span>신고 대상 기간</span>
                <input
                  value={form.period}
                  onChange={(event) => update("period", event.target.value)}
                  placeholder="예: 2026년 제1기 예정신고"
                />
              </label>
              <label className="form-field form-field-wide">
                <span>핵심 검토 범위</span>
                <textarea
                  value={form.summary}
                  onChange={(event) => update("summary", event.target.value)}
                  rows={5}
                  placeholder="검토할 쟁점과 기대 산출물을 작성해 주세요."
                />
                <small>
                  AI 분석의 초기 범위로 사용되며 이후에도 수정할 수 있습니다.
                </small>
              </label>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="form-grid">
              <label className="form-field">
                <span>검토자</span>
                <select
                  value={form.reviewerId}
                  onChange={(event) => update("reviewerId", event.target.value)}
                >
                  {reviewers.map((reviewer) => (
                    <option key={reviewer.id} value={reviewer.id}>
                      {reviewer.name} ·{" "}
                      {reviewer.role === "ADMIN" ? "관리자" : "검토자"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                <span>업무 마감일</span>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(event) => update("dueDate", event.target.value)}
                />
              </label>
              <div className="assignment-preview form-field-wide">
                <span className="reviewer-avatar">{owner.initials}</span>
                <div>
                  <strong>{owner.name} · 담당자</strong>
                  <small>업무 관리, 자료 등록, AI 초안 작성</small>
                </div>
                <ArrowRight size={16} />
                <span className="reviewer-avatar reviewer-avatar-violet">
                  {selectedReviewer?.name.slice(0, 1) ?? "-"}
                </span>
                <div>
                  <strong>{selectedReviewer?.name ?? "미지정"} · 검토자</strong>
                  <small>결론 검토, 승인 또는 반려</small>
                </div>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="review-summary">
              <div>
                <span>고객사</span>
                <strong>{form.client}</strong>
              </div>
              <div>
                <span>세목 · 기간</span>
                <strong>
                  {form.taxType} · {form.period}
                </strong>
              </div>
              <div>
                <span>검토 범위</span>
                <strong>{form.summary}</strong>
              </div>
              <div>
                <span>검토자 · 마감일</span>
                <strong>
                  {selectedReviewer?.name ?? "미지정"} · {form.dueDate}
                </strong>
              </div>
              <div className="review-policy">
                <ShieldCheck size={18} />
                <p>
                  AI는 근거 검색과 계산만 자동으로 수행합니다. 검토자가 승인하기
                  전까지 결론 확정과 외부 반영은 차단됩니다.
                </p>
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="form-panel-footer">
          {step === 0 ? (
            <Link className="button button-secondary" href="/cases">
              취소
            </Link>
          ) : (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setStep((current) => current - 1)}
            >
              <ArrowLeft size={15} /> 이전
            </button>
          )}
          {step < steps.length - 1 ? (
            <button
              className="button button-primary"
              type="button"
              onClick={() => setStep((current) => current + 1)}
            >
              계속 <ArrowRight size={15} />
            </button>
          ) : (
            <button
              className="button button-primary"
              type="button"
              onClick={submit}
              disabled={submitting || !form.reviewerId}
            >
              {submitting ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}
              업무 등록
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
