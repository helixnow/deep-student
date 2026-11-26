import os
from pathlib import Path

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer


user = os.environ.get("FTP_USER_NAME", "ftpuser")
password = os.environ.get("FTP_USER_PASS", "ftpuser123")
home = Path(os.environ.get("FTP_USER_HOME", "/home/ftpuser"))
host = os.environ.get("FTP_HOST", "0.0.0.0")
port = int(os.environ.get("FTP_PORT", "21"))
passive_start = int(os.environ.get("FTP_PASSIVE_PORT_START", "30000"))
passive_end = int(os.environ.get("FTP_PASSIVE_PORT_END", "30009"))
home.mkdir(parents=True, exist_ok=True)

authorizer = DummyAuthorizer()
authorizer.add_user(user, password, str(home), perm="elradfmwMT")

handler = FTPHandler
handler.authorizer = authorizer
handler.masquerade_address = "127.0.0.1"
handler.passive_ports = range(passive_start, passive_end + 1)

server = FTPServer((host, port), handler)
server.serve_forever()
