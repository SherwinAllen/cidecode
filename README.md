To get started with this project, follow these steps:

```git clone https://github.com/SherwinAllen/cidecode.git```

```cd cidecode```

---

**Recommended:**  
Create a Python virtual environment for the backend (for isolation and dependency management):

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # On Mac/Linux
# .venv\Scripts\activate   # On Windows
```

> **Note:** Always ensure your backend server is running with the virtual environment activated.  
> This ensures all Python scripts use the correct dependencies from `.venv`.

---

Setup node dependencies:

```npm install```

Setup the backend dependencies:

```pip install -r backend/requirements.txt```

To start the backend (with the virtual environment activated): 

```node backend/server.js```

Then, open a new terminal, and launch the frontend using:

```npm start```
