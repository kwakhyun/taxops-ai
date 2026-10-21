import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AssistantWorkspace } from "@/components/assistant-workspace";
import { getSessionUser } from "@/lib/auth/session";
import { evidence as demoEvidence } from "@/lib/domain/fixtures";
import { findMatter, listDocuments, listMatters } from "@/lib/repository";

export const metadata: Metadata = { title: "AI 분석" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ matter?: string | string[] }> };

export default async function AssistantPage({ searchParams }: Props) {
  const query = await searchParams;
  const requestedMatter =
    typeof query.matter === "string" ? query.matter : undefined;
  const user = await getSessionUser();
  const defaultMatter = requestedMatter
    ? undefined
    : ((await findMatter(user, "vat-2025-q4")) ?? (await listMatters(user))[0]);
  const matter = requestedMatter
    ? await findMatter(user, requestedMatter)
    : defaultMatter;
  if (!matter) notFound();
  const matterDocuments = await listDocuments(user, matter.id);
  const initialEvidence =
    !process.env.DATABASE_URL && matter.id === "vat-2025-q4"
      ? demoEvidence.map((item) => ({
          id: item.id,
          documentName: item.documentName,
          location: item.page
            ? `${item.page}쪽 · ${item.section}`
            : item.section,
          excerpt: item.excerpt,
          score: item.score,
          contentHash: item.contentHash,
        }))
      : [];

  return (
    <AssistantWorkspace
      key={matter.id}
      matter={matter}
      userName={user.name}
      userInitials={user.initials}
      documentCount={matterDocuments.length}
      initialEvidence={initialEvidence}
    />
  );
}
