#/bin/bash

# ARGC
if [ ! -z "${BRANCH}"]; then
    ARGC="${BRANCH}"
elif [ ! -z "$1" ]; then
    ARGC=$1
else
    ARGC="prod"
fi

echo "Wellcome to use Tus-Server ... "
date "+%Y/%m/%dT%T--%z"
echo "=================work for ${ARGC}"

if [ "${ARGC}" == "dev" ]; then
    echo "Running in development mode..."
    if [ -e .tusserverinit ]; then
        rm .tusserverinit
    fi
elif [ "${ARGC}" == "prod" ]; then
    echo "Running in production mode..."
else
    echo "Running in [${ARGC}] mode..."
    # if [ -e .tusserverinit ]; then
    #     rm .tusserverinit
    # fi
fi

if [ ! -f .tusserverinit ]; then
    echo "Tus-Server initialization started..."
    npm install
    npm audit fix 

    # Create a file to indicate that initialization has been done
    touch .tusserverinit
    echo "Tus-Server initialization completed."
else
    echo "Tus-Server is already initialized. Skipping initialization."
fi

if [ "${ARGC}" == "dev" ]; then
    echo "Waiting virtual working env. be created ..."
    npm run dev
else
    # build and start the tus-server in production mode
    echo "Waiting for the server to be ready before starting the tus-server..."
    npm run build
    echo "Starting the tus-server..."
    npm run start
fi
