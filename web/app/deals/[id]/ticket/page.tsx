import { TicketView } from "@/components/ticket-view";

export default function Page({ params }: { params: { id: string } }) {
  return <TicketView id={params.id} />;
}
