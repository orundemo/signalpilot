import { redirect } from "next/navigation";

export default function OrgRoot({ params }: { params: { orgSlug: string } }) {
  // The org root resolves to the product's home surface in both profiles.
  // Prospects, not Projects: the board is what the operator came for, and under
  // Solo the projects surface is suppressed at the edge anyway.
  redirect(`/orgs/${params.orgSlug}/prospects`);
}
