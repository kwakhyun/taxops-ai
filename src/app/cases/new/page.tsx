import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewCaseForm } from "@/components/new-case-form";
import { can } from "@/lib/auth/rbac";
import { getSessionUser } from "@/lib/auth/session";
import { listReviewers } from "@/lib/repository";

export const metadata: Metadata = { title: "새 케이스" };

export default async function NewCasePage() {
  const user = await getSessionUser();
  if (!can(user, "case:write")) notFound();
  const reviewers = await listReviewers(user);
  return (
    <NewCaseForm
      owner={{ name: user.name, initials: user.initials }}
      reviewers={reviewers}
    />
  );
}
