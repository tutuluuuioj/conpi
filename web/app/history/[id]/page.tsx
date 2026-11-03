import { ReceiptView } from "@/components/receipt-view";

export default function Page({ params }: { params: { id: string } }) {
  return <ReceiptView id={params.id} />;
}
