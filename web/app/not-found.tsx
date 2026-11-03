import { Button } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">That route is not part of Conpi.</p>
      <div className="mt-4 flex justify-center">
        <Button href="/">Back to market</Button>
      </div>
    </div>
  );
}
