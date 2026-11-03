import { ListingView } from "@/components/listing-view";

export default function Page({ params }: { params: { id: string } }) {
  return <ListingView id={params.id} />;
}
