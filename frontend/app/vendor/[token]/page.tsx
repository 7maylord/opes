import { VendorPortal } from "./vendor-portal";

export default async function VendorPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VendorPortal token={token} />;
}
