"""Small pinned hooks: native notes/history/tool results use prepared projections."""
from .archive_tools import request


def prepare(value,read=None):
    """`read`, for a tool result, names what it read (note_sources.gate_read): storage keeps it for the turn before the
    model sees the result, so a command later in the turn asks first (ADR-0293)."""
    from .timing import measure
    with measure('context_prepare'):return request('/v1/context/prepare'+('' if read is None else '?read='+read), value)


def install():
    from tools.memory_tool import MemoryStore
    from run_agent import AIAgent
    original_read=MemoryStore._read_raw_checked
    original_write=MemoryStore._write_file
    original_tool=AIAgent._tool_result_content_for_active_model

    def read(path):
        raw,ok=original_read(path)
        return (prepare(raw) if ok and raw else raw),ok

    def write(path,entries):
        # The preparation service archives the unmodified new text separately.
        return original_write(path,prepare(entries))

    def tool(agent,name,result):
        from .note_sources import gate_read
        content=original_tool(agent,name,result)
        return prepare(content,gate_read(name,content))

    MemoryStore._read_raw_checked=staticmethod(read)
    MemoryStore._write_file=staticmethod(write)
    AIAgent._tool_result_content_for_active_model=tool

    def restore():
        MemoryStore._read_raw_checked=staticmethod(original_read)
        MemoryStore._write_file=staticmethod(original_write)
        AIAgent._tool_result_content_for_active_model=original_tool
    return restore
