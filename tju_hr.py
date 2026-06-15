#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
监听 qBittorrent 中分类为 TJU 的种子：

- 下载进度 <= 8%：不处理
- 添加超过 12 小时且下载进度仍为 0%：删种删文件
- 体积 >= 20GiB：不再做 8%-10% 预删，直接下载到完成
- 若 tracker 明确返回“种子已被站点删除/未注册”等错误：直接视为免考并删种删文件
- 下载完成后：按北洋园 PT 的 H&R 规则计算所需做种时长，达标后删种并删除文件
- 说明：站点侧“完成数未增加免考”依赖站点数据，本脚本未实现

特点：
1. 不依赖 requests / pip，只使用 Python 标准库
2. 支持 --once：只执行一轮，适合手工调试
3. 支持 --cron-minute：内部每秒检查一次，共检查 60 次，适合 cron 每分钟拉起一次
4. 支持脚本内防重入锁，避免 cron 叠加运行

推荐 crontab：
* * * * * /usr/bin/python3 /data/shell/qb_tju_throttle.py --cron-minute >> /data/shell/qb_tju_throttle.log 2>&1
"""

from __future__ import annotations

import argparse
import fcntl
import html
import http.cookiejar
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from typing import Any


QB_URL = os.getenv("QB_URL", "http://127.0.0.1:8080").rstrip("/")
QB_USERNAME = os.getenv("QB_USERNAME", "admin")
QB_PASSWORD = os.getenv("QB_PASSWORD", "").strip()
QB_PASSWORD_FILE = os.getenv(
    "QB_PASSWORD_FILE",
    os.path.join(os.path.dirname(__file__), ".qb_password"),
)
QB_PASSWORD_FALLBACK = "password"

CATEGORY = os.getenv("QB_CATEGORY", "TJU")
POLL_INTERVAL = float(os.getenv("QB_POLL_INTERVAL", "3"))       # 常驻模式间隔
REQUEST_TIMEOUT = float(os.getenv("QB_REQUEST_TIMEOUT", "10"))
SITE_URL = os.getenv("QB_SITE_URL", "https://tjupt.org").rstrip("/")
SITE_COOKIE = os.getenv("QB_SITE_COOKIE", "").strip()
SITE_COOKIE_FILE = os.getenv(
    "QB_SITE_COOKIE_FILE",
    os.path.join(os.path.dirname(__file__), ".tjupt_cookie"),
)
SITE_REQUEST_TIMEOUT = float(os.getenv("QB_SITE_REQUEST_TIMEOUT", "15"))
HR_BUFFER_SECONDS = int(os.getenv("QB_HR_BUFFER_SECONDS", "1800"))
ZERO_PROGRESS_DELETE_AFTER_SECONDS = int(os.getenv("QB_ZERO_PROGRESS_DELETE_AFTER_SECONDS", str(12 * 3600)))
SITE_DELETED_KEYWORDS = tuple(
    s.strip().lower()
    for s in os.getenv(
        "QB_SITE_DELETED_KEYWORDS",
        "unregistered torrent,torrent not registered,not registered with this tracker,"
        "torrent not exists,torrent does not exist,no torrent with id,deleted,被删除,未注册,不存在",
    ).split(",")
    if s.strip()
)

GIB = 1024 ** 3
SIZE_10_GIB = int(os.getenv("QB_SIZE_10_GIB", str(10 * GIB)))

CRON_LOOPS = int(os.getenv("QB_CRON_LOOPS", "60"))              # cron 每分钟内部循环次数
CRON_SLEEP_SECONDS = float(os.getenv("QB_CRON_SLEEP_SECONDS", "1"))
LOCK_FILE = os.getenv("QB_LOCK_FILE", "/tmp/qb_tju_throttle.lock")
VERBOSE_LOG = os.getenv("QB_VERBOSE_LOG", "0") == "1"

DETAILS_ID_RE = re.compile(r"(?:details\.php\?id=|/details\.php\?id=)(\d+)")
HNR_ROW_CELL_RE = re.compile(r"<td\s+class=\"rowfollow(?:\s+nowrap)?\"[^>]*>(.*?)</td>", re.S)
HNR_DELETE_STATUSES = ("已达标", "后达标", "免考")
HNR_KEEP_STATUSES = ("未开始", "等待中", "等待期", "考核中", "未达标")
HR_BASE_TAG = os.getenv("QB_HR_BASE_TAG", "HR")
HR_TAG_LE_1H = os.getenv("QB_HR_TAG_LE_1H", "HR-1h内")
HR_TAG_LE_6H = os.getenv("QB_HR_TAG_LE_6H", "HR-6h内")
HR_TAG_LE_24H = os.getenv("QB_HR_TAG_LE_24H", "HR-24h内")
HR_TAG_GT_24H = os.getenv("QB_HR_TAG_GT_24H", "HR-24h+")


cookie_jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))


def log(*args: Any) -> None:
    print(time.strftime("[%Y-%m-%d %H:%M:%S]"), *args, flush=True)


def http_post(path: str, data: dict[str, Any]) -> str:
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        f"{QB_URL}{path}",
        data=body,
        headers={
            "Referer": QB_URL,
            "Origin": QB_URL,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        method="POST",
    )
    with opener.open(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def http_get_json(path: str, params: dict[str, Any] | None = None) -> Any:
    url = f"{QB_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "Referer": QB_URL,
            "Origin": QB_URL,
        },
        method="GET",
    )
    with opener.open(req, timeout=REQUEST_TIMEOUT) as resp:
        text = resp.read().decode("utf-8", errors="replace")
        return json.loads(text)


def http_get_text_by_url(url: str, headers: dict[str, str] | None = None, timeout: float | None = None) -> tuple[str, str]:
    req = urllib.request.Request(
        url,
        headers=headers or {},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT if timeout is None else timeout) as resp:
        text = resp.read().decode("utf-8", errors="replace")
        return text, resp.geturl()


def login() -> None:
    text = http_post(
        "/api/v2/auth/login",
        {
            "username": QB_USERNAME,
            "password": get_qb_password(),
        },
    ).strip()
    if text != "Ok.":
        raise RuntimeError(f"qB 登录失败: {text}")


def get_torrents_by_category(category: str) -> list[dict[str, Any]]:
    data = http_get_json("/api/v2/torrents/info", {"category": category})
    if not isinstance(data, list):
        raise RuntimeError(f"获取种子列表返回异常: {type(data)!r}")
    return data


def get_torrent_properties(torrent_hash: str) -> dict[str, Any]:
    data = http_get_json("/api/v2/torrents/properties", {"hash": torrent_hash})
    if not isinstance(data, dict):
        return {}
    return data


def delete_torrent_with_files(torrent_hash: str) -> None:
    http_post(
        "/api/v2/torrents/delete",
        {
            "hashes": torrent_hash,
            "deleteFiles": "true",
        },
    )


def add_tags(torrent_hash: str, tags: list[str]) -> None:
    if not tags:
        return
    http_post(
        "/api/v2/torrents/addTags",
        {
            "hashes": torrent_hash,
            "tags": ",".join(tags),
        },
    )


def remove_tags(torrent_hash: str, tags: list[str]) -> None:
    if not tags:
        return
    http_post(
        "/api/v2/torrents/removeTags",
        {
            "hashes": torrent_hash,
            "tags": ",".join(tags),
        },
    )


def normalize_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def get_torrent_size(torrent: dict[str, Any]) -> int:
    total_size = normalize_int(torrent.get("total_size"), -1)
    if total_size >= 0:
        return total_size
    return normalize_int(torrent.get("size"), -1)


def format_gib(size_bytes: int) -> str:
    if size_bytes < 0:
        return "unknown"
    return f"{size_bytes / GIB:.2f}GiB"


def get_site_cookie() -> str:
    if SITE_COOKIE:
        return SITE_COOKIE
    try:
        with open(SITE_COOKIE_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def get_qb_password() -> str:
    if QB_PASSWORD:
        return QB_PASSWORD
    try:
        with open(QB_PASSWORD_FILE, "r", encoding="utf-8") as f:
            password = f.read().strip()
            if password:
                return password
    except FileNotFoundError:
        pass
    return QB_PASSWORD_FALLBACK


def clean_html_text(value: str) -> str:
    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = re.sub(r"(?is)<[^>]+>", "", value)
    value = html.unescape(value)
    value = value.replace("\xa0", " ")
    return "\n".join(x.strip() for x in value.splitlines() if x.strip()).strip()


def parse_tags(raw_tags: str) -> list[str]:
    return [x.strip() for x in (raw_tags or "").split(",") if x.strip()]


def build_hr_time_tag(remaining_seconds: int) -> str:
    remaining_seconds = max(0, int(remaining_seconds))
    if remaining_seconds <= 3600:
        return HR_TAG_LE_1H
    if remaining_seconds <= 6 * 3600:
        return HR_TAG_LE_6H
    if remaining_seconds <= 24 * 3600:
        return HR_TAG_LE_24H
    return HR_TAG_GT_24H


def extract_remaining_seconds(active_time: str) -> int | None:
    match = re.search(r"剩余：(?:(\d+)天)?(\d+):(\d+):(\d+)", active_time or "")
    if not match:
        return None
    days = int(match.group(1) or 0)
    hours = int(match.group(2) or 0)
    minutes = int(match.group(3) or 0)
    seconds = int(match.group(4) or 0)
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def sync_hr_tags(torrent_hash: str, raw_tags: str, remaining_seconds: int) -> None:
    current_tags = parse_tags(raw_tags)
    remove_list = [
        tag for tag in current_tags
        if tag == HR_BASE_TAG
        or tag in {
            HR_TAG_LE_1H,
            HR_TAG_LE_6H,
            HR_TAG_LE_24H,
            HR_TAG_GT_24H,
        }
        or tag.startswith("HR-")
    ]
    if remove_list:
        remove_tags(torrent_hash, remove_list)

    add_list = [HR_BASE_TAG, build_hr_time_tag(remaining_seconds)]
    add_tags(torrent_hash, add_list)


def get_torrent_trackers(torrent_hash: str) -> list[dict[str, Any]]:
    data = http_get_json("/api/v2/torrents/trackers", {"hash": torrent_hash})
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def is_special_tracker_url(url: str) -> bool:
    return url.startswith("** [") and url.endswith("] **")


def is_site_deleted_tracker(trackers: list[dict[str, Any]]) -> bool:
    for tracker in trackers:
        url = str(tracker.get("url", "") or "")
        if not url or is_special_tracker_url(url):
            continue

        msg = str(tracker.get("msg", "") or "").strip().lower()
        if not msg:
            continue

        for keyword in SITE_DELETED_KEYWORDS:
            if keyword in msg:
                return True
    return False


def extract_torrent_id_from_comment(comment: str) -> str:
    match = DETAILS_ID_RE.search(comment or "")
    if not match:
        return ""
    return match.group(1)


def fetch_hnr_status(sid: str, site_cookie: str) -> dict[str, str]:
    url = f"{SITE_URL}/hnr_details.php?sid={sid}"
    try:
        text, final_url = http_get_text_by_url(
            url,
            headers={
                "Cookie": site_cookie,
                "User-Agent": "Mozilla/5.0",
                "Referer": SITE_URL + "/",
            },
            timeout=SITE_REQUEST_TIMEOUT,
        )
    except Exception as e:
        return {"mode": "error", "message": str(e)}

    lowered = text.lower()
    if "login.php" in final_url.lower() or "<title>北洋园pt :: 登录" in lowered:
        return {"mode": "auth_failed", "message": "cookie 已失效或未登录"}

    if "暂无记录" in text:
        return {"mode": "no_record", "message": "暂无记录"}

    sid_marker = f"种子ID: {sid}"
    idx = text.find(sid_marker)
    if idx < 0:
        return {"mode": "unknown", "message": "未找到对应 sid 行"}

    row_start = text.rfind("<tr", 0, idx)
    row_end = text.find("</tr>", idx)
    if row_start < 0 or row_end < 0:
        return {"mode": "unknown", "message": "未找到对应表格行"}

    row_html = text[row_start:row_end]
    cells = HNR_ROW_CELL_RE.findall(row_html)
    if len(cells) < 8:
        return {"mode": "unknown", "message": f"表格列数量异常: {len(cells)}"}

    torrent_state = clean_html_text(cells[5])
    active_time = clean_html_text(cells[6])
    hnr_status = clean_html_text(cells[7])
    return {
        "mode": "ok",
        "torrent_state": torrent_state,
        "active_time": active_time,
        "hnr_status": hnr_status,
    }


def should_delete_by_hnr_page(hnr_status: str) -> bool:
    return any(x in hnr_status for x in HNR_DELETE_STATUSES)


def should_keep_by_hnr_page(hnr_status: str) -> bool:
    return any(x in hnr_status for x in HNR_KEEP_STATUSES)


def get_hr_score(size_bytes: int) -> float:
    if size_bytes < 0:
        return 0.0

    size_gib = size_bytes / GIB
    if size_gib <= 10:
        return 2.0
    if size_gib <= 50:
        return 2.0 + (size_gib - 10.0) * 0.2
    return 10.0


def get_hr_base_seed_time(size_bytes: int) -> int:
    if size_bytes < 0:
        return 0
    if size_bytes <= 10 * GIB:
        return 24 * 3600
    if size_bytes <= 20 * GIB:
        return 48 * 3600
    if size_bytes <= 30 * GIB:
        return 72 * 3600
    if size_bytes <= 40 * GIB:
        return 96 * 3600
    if size_bytes <= 50 * GIB:
        return 120 * 3600
    return 168 * 3600


def get_hr_reduction_fraction(size_bytes: int, ratio: float) -> float:
    if size_bytes < 0 or ratio <= 0:
        return 0.0

    hr_score = get_hr_score(size_bytes)
    reduction = ratio * hr_score / 10.0
    return min(1.0, max(0.0, reduction))


def get_hr_required_seed_time(size_bytes: int, ratio: float) -> int:
    base_seed_time = get_hr_base_seed_time(size_bytes)
    reduction_fraction = get_hr_reduction_fraction(size_bytes, ratio)
    remaining = base_seed_time * (1.0 - reduction_fraction)
    return max(0, int(math.ceil(remaining)) + HR_BUFFER_SECONDS)


def should_delete_hr_torrent(
    size_bytes: int,
    progress: float,
    seeding_time: int,
    ratio: float,
) -> bool:
    if size_bytes < 0 or progress < 1.0:
        return False
    return seeding_time >= get_hr_required_seed_time(size_bytes, ratio)


def should_delete_zero_progress_torrent(
    progress: float,
    added_on: int,
    now_ts: int | None = None,
) -> bool:
    if ZERO_PROGRESS_DELETE_AFTER_SECONDS <= 0:
        return False
    if added_on <= 0:
        return False
    if progress > 0.0:
        return False

    if now_ts is None:
        now_ts = int(time.time())
    return now_ts - added_on >= ZERO_PROGRESS_DELETE_AFTER_SECONDS


def log_delete(
    reason: str,
    torrent_hash: str,
    name: str,
    state: str,
    size_bytes: int,
    progress: float,
    extra: str = "",
) -> None:
    delete_torrent_with_files(torrent_hash)
    message = (
        f"已删种并删除文件[{reason}]: name={name!r}, state={state}, "
        f"size={format_gib(size_bytes)}, progress={progress:.4f}"
    )
    if extra:
        message += f", {extra}"
    log(message)


def run_once() -> tuple[int, int]:
    login()
    torrents = get_torrents_by_category(CATEGORY)
    site_cookie = get_site_cookie()
    site_cookie_invalid = False

    matched_count = 0
    deleted_count = 0

    for t in torrents:
        torrent_hash = t.get("hash", "")
        name = t.get("name", "")
        raw_tags = str(t.get("tags", "") or "")
        progress = normalize_float(t.get("progress"), -1.0)
        ratio = normalize_float(t.get("ratio"), 0.0)
        state = t.get("state", "")
        seeding_time = normalize_int(t.get("seeding_time"), 0)
        added_on = normalize_int(t.get("added_on"), 0)
        size_bytes = get_torrent_size(t)

        if not torrent_hash:
            continue

        if should_delete_zero_progress_torrent(progress, added_on):
            matched_count += 1
            age_seconds = max(0, int(time.time()) - added_on)
            log_delete(
                "超过12小时进度为0",
                torrent_hash,
                name,
                state,
                size_bytes,
                progress,
                (
                    f"added_on={added_on}, age_seconds={age_seconds}, "
                    f"threshold_seconds={ZERO_PROGRESS_DELETE_AFTER_SECONDS}"
                ),
            )
            deleted_count += 1
            continue

        trackers = get_torrent_trackers(torrent_hash)
        if is_site_deleted_tracker(trackers):
            matched_count += 1
            tracker_msgs = " | ".join(
                str(x.get("msg", "") or "").strip()
                for x in trackers
                if not is_special_tracker_url(str(x.get("url", "") or ""))
                and str(x.get("msg", "") or "").strip()
            )
            log_delete(
                "站点删种",
                torrent_hash,
                name,
                state,
                size_bytes,
                progress,
                f"tracker_msg={tracker_msgs!r}",
            )
            deleted_count += 1
            continue

        if progress >= 1.0 and site_cookie and not site_cookie_invalid:
            props = get_torrent_properties(torrent_hash)
            sid = extract_torrent_id_from_comment(str(props.get("comment", "") or ""))
            if sid:
                hnr_result = fetch_hnr_status(sid, site_cookie)
                mode = hnr_result.get("mode", "")

                if mode == "auth_failed":
                    site_cookie_invalid = True
                elif mode == "ok":
                    hnr_status = hnr_result.get("hnr_status", "")
                    matched_count += 1
                    if should_delete_by_hnr_page(hnr_status):
                        log_delete(
                            "站点状态达标",
                            torrent_hash,
                            name,
                            state,
                            size_bytes,
                            progress,
                            (
                                f"sid={sid}, "
                                f"torrent_state={hnr_result.get('torrent_state', '')!r}, "
                                f"active_time={hnr_result.get('active_time', '')!r}, "
                                f"hnr_status={hnr_status!r}"
                            ),
                        )
                        deleted_count += 1
                        continue
                    if should_keep_by_hnr_page(hnr_status):
                        remaining_seconds = extract_remaining_seconds(
                            hnr_result.get("active_time", "")
                        )
                        if remaining_seconds is None:
                            remaining_seconds = max(
                                0,
                                get_hr_required_seed_time(size_bytes, ratio) - seeding_time,
                            )
                        sync_hr_tags(torrent_hash, raw_tags, remaining_seconds)
                        if VERBOSE_LOG:
                            log(
                                f"保留种子: name={name!r}, state={state}, "
                                f"size={format_gib(size_bytes)}, progress={progress:.4f}, sid={sid}"
                            )
                        continue
                elif mode == "no_record":
                    if VERBOSE_LOG:
                        log(
                            f"站点状态未获取到记录: name={name!r}, sid={sid}, size={format_gib(size_bytes)}"
                        )
                else:
                    if VERBOSE_LOG:
                        log(
                            f"站点状态查询失败: name={name!r}, sid={sid}, "
                            f"reason={hnr_result.get('message', 'unknown')}"
                        )

        if should_delete_hr_torrent(size_bytes, progress, seeding_time, ratio):
            matched_count += 1
            hr_score = get_hr_score(size_bytes)
            hr_base_seed_time = get_hr_base_seed_time(size_bytes)
            hr_required_seed_time = get_hr_required_seed_time(size_bytes, ratio)
            log_delete(
                "本地规则达标",
                torrent_hash,
                name,
                state,
                size_bytes,
                progress,
                (
                    f"seeding_time={seeding_time}, ratio={ratio:.4f}, "
                    f"hr_score={hr_score:.2f}, base_seed_time={hr_base_seed_time}, "
                    f"required_seed_time={hr_required_seed_time}"
                ),
            )
            deleted_count += 1
            continue

        if progress >= 1.0:
            remaining_seconds = max(0, get_hr_required_seed_time(size_bytes, ratio) - seeding_time)
            sync_hr_tags(torrent_hash, raw_tags, remaining_seconds)

    if deleted_count > 0 or VERBOSE_LOG:
        log(
            f"本轮扫描完成: 命中={matched_count}, 删除={deleted_count}"
        )

    return matched_count, deleted_count


@contextmanager
def maybe_lock(lock_file: str, enable: bool):
    if not enable:
        yield True
        return

    lock_handle = open(lock_file, "w")
    try:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield True
        except BlockingIOError:
            log(f"已有实例运行中，跳过本次执行: {lock_file}")
            yield False
    finally:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        lock_handle.close()


def run_cron_minute(use_lock: bool = True) -> int:
    with maybe_lock(LOCK_FILE, use_lock) as locked:
        if not locked:
            return 0

        total_matched = 0
        total_deleted = 0
        error_count = 0

        for i in range(1, CRON_LOOPS + 1):
            try:
                matched_count, deleted_count = run_once()
                total_matched += matched_count
                total_deleted += deleted_count
            except KeyboardInterrupt:
                log("收到中断，脚本退出")
                return 0
            except Exception as e:
                error_count += 1
                log(f"第 {i}/{CRON_LOOPS} 轮运行异常: {e}")

            if i < CRON_LOOPS:
                time.sleep(CRON_SLEEP_SECONDS)

        if total_deleted > 0 or error_count > 0 or VERBOSE_LOG:
            log(
                f"cron-minute 执行完成: 总轮次={CRON_LOOPS}, "
                f"累计命中={total_matched}, 累计删除={total_deleted}, 异常={error_count}"
            )
        return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="监听 qBittorrent 中 TJU 分类种子，并按体积/做种时长执行限速或删除。"
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="只执行一轮扫描后退出，适合手工调试。",
    )
    parser.add_argument(
        "--cron-minute",
        action="store_true",
        help="适合 cron 每分钟拉起一次：脚本内部每秒检查一次，共 60 次。",
    )
    parser.add_argument(
        "--no-lock",
        action="store_true",
        help="禁用脚本内防重入锁。默认启用。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if VERBOSE_LOG or not args.cron_minute:
        if args.once:
            mode = "单轮"
        elif args.cron_minute:
            mode = "cron-minute"
        else:
            mode = "常驻"
        log(f"启动 qB 监听: url={QB_URL}, 模式={mode}")

    if args.once:
        try:
            run_once()
            return 0
        except KeyboardInterrupt:
            log("收到中断，脚本退出")
            return 0
        except Exception as e:
            log(f"运行异常: {e}")
            return 1

    if args.cron_minute:
        return run_cron_minute(use_lock=not args.no_lock)

    log(f"进入常驻轮询模式，间隔 {POLL_INTERVAL}s")
    while True:
        try:
            run_once()
        except KeyboardInterrupt:
            log("收到中断，脚本退出")
            return 0
        except Exception as e:
            log(f"运行异常: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
