import { Suspense } from "react";
import { MarketSkeleton, MarketView } from "@/components/market-view";

export default function Page() {
  return (
    <Suspense fallback={<MarketSkeleton />}>
      <MarketView />
    </Suspense>
  );
}
