To get started with this project, follow these steps:

```bash
git clone https://github.com/SherwinAllen/cidecode.git
```

```bash
cd cidecode
```

---

**Recommended:**  
Create a Python virtual environment for the backend (for isolation and dependency management):

```bash
cd backend
python -m venv .venv
source .venv/bin/activate      # On Mac/Linux
# .venv\Scripts\activate       # On Windows
# .venv\Scripts\Activate.ps1   # On Windows PowerShell
```

> **Note:** Always ensure your backend server is running with the virtual environment activated.  
> This ensures all Python scripts use the correct dependencies from `.venv`.

---

Setup node dependencies:

```bash
npm install
```

Setup the backend dependencies:

```bash
pip install -r backend/requirements.txt
```
> **Note:** Configure the Environment Variables as shown in ```.env.example```

To start the backend (with the virtual environment activated): 

```bash
node backend/server.js
```

Then, open a new terminal, and launch the frontend using:

```bash
npm start
```
