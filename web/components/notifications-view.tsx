"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button, Card, EmptyState } from "./ui";
import { useState } from "react";

export function NotificationsView() {
  const app = useApp();
  const [filter, setFilter] = useState("all");
  const rows = app.notices.filter((notice) => filter === "all" || notice.kind === filter || (filter === "unread" && !notice.read));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight md:text-[32px] md:leading-10">Notifications</h1>
          <p className="mt-2 text-sm text-muted">Offers, deposits, releases, and claims.</p>
        </div>
        <Button variant="secondary" onClick={app.markAllNotices}>Mark all read</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {["all", "unread", "claim", "stage", "governance"].map((item) => (
          <button key={item} type="button" className={`rounded-sm border px-2 py-1 text-xs font-semibold capitalize ${filter === item ? "border-brand text-brand" : "border-line text-muted"}`} onClick={() => setFilter(item)}>{item}</button>
        ))}
      </div>
      {rows.length === 0 ? <EmptyState icon={<Bell className="h-6 w-6" />} title="No notifications." body="Deal events will show up here." /> : (
        <div className="space-y-2">
          {rows.map((notice) => (
            <Link key={notice.id} href={notice.href} onClick={() => app.markNotice(notice.id)}>
              <Card interactive>
                <div className="flex items-center gap-2">
                  {!notice.read ? <span className="h-1.5 w-1.5 rounded-full bg-brand" /> : null}
                  <span className="font-semibold">{notice.title}</span>
                  <span className="ml-auto text-xs text-muted">{notice.time}</span>
                </div>
                <p className="mt-1 text-sm text-muted">{notice.body}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
