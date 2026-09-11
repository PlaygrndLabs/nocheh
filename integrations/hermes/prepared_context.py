"""Small pinned hooks: native notes/history/tool results use prepared projections."""
from .archive_tools import request


def prepare(value):
    return request('/v1/context/prepare', value)


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
        return prepare(original_tool(agent,name,result))

    MemoryStore._read_raw_checked=staticmethod(read)
    MemoryStore._write_file=staticmethod(write)
    AIAgent._tool_result_content_for_active_model=tool

    def restore():
        MemoryStore._read_raw_checked=staticmethod(original_read)
        MemoryStore._write_file=staticmethod(original_write)
        AIAgent._tool_result_content_for_active_model=original_tool
    return restore
