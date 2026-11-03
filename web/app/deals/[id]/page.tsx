import { DealView } from "@/components/deal-view";

export default function Page({ params }: { params: { id: string } }) {
  return <DealView id={params.id} />;
}
